/**
 * @file ShinNormalizer_V10_DualBalance.js
 * @description 
 * [정상화의 신 V10.0] 듀얼 밸런싱 & 도메인 무결성 에디션
 * - balanceTarget 옵션 추가 ('row' | 'user')
 * - 'user' 모드: 헤비 유저의 데이터 편중을 무시하고, 고유 사용자 수를 기준으로 균등 분배.
 * - 결과 출력 시 해당 파티션의 예상 Row 수와 고유 User 수를 동시에 제공.
 */

function normalizePartitions(userIds, numPartitions, majorCategories = [], options = {}) {
    const { 
        includeNotAll = true, 
        maxDepth = 10, 
        allowMixing = false,
        granularity = 0.05,
        balanceTarget = 'row' // [V10 핵심] 'row'(데이터 총량) 또는 'user'(고유 사용자 수)
    } = options;

    // 1. 데이터 전처리 및 압축 (성능 극대화)
    const userStats = new Map();
    let emptyOrNullRowCount = 0;

    userIds.forEach(id => {
        if (!id || id.toString().trim() === '') {
            emptyOrNullRowCount++;
            return;
        }
        const strId = id.toString();
        userStats.set(strId, (userStats.get(strId) || 0) + 1);
    });

    const totalUniqueUsers = userStats.size;
    const totalValidRows = userIds.length - emptyOrNullRowCount;

    // 밸런싱 기준에 따른 가중치(Weight) 계산 함수
    const getWeight = (idsArray) => {
        if (balanceTarget === 'user') return idsArray.length;
        let sum = 0;
        for (let i = 0; i < idsArray.length; i++) sum += userStats.get(idsArray[i]);
        return sum;
    };

    const getRowCount = (idsArray) => {
        let sum = 0;
        for (let i = 0; i < idsArray.length; i++) sum += userStats.get(idsArray[i]);
        return sum;
    };

    // 2. 초기 그룹핑
    const categoryGroups = { 'CatchAll': [] };
    majorCategories.forEach(cat => categoryGroups[cat] = []);

    for (const strId of userStats.keys()) {
        const matched = majorCategories.find(cat => strId.startsWith(cat));
        if (matched) categoryGroups[matched].push(strId);
        else categoryGroups['CatchAll'].push(strId);
    }

    // 3. 자율 세분화 (Drill-down)
    function drillAndSort(initialGroupMap, targetCapacity) {
        const splitThreshold = Math.max(Math.ceil(targetCapacity * granularity), 10); 
        const finalGroups = {};
        
        const queue = Object.keys(initialGroupMap).map(prefix => ({
            prefix, ids: initialGroupMap[prefix]
        }));

        while (queue.length > 0) {
            const { prefix, ids } = queue.shift();

            if (prefix.startsWith('EXACT_')) {
                finalGroups[prefix] = ids;
                continue;
            }

            const weight = getWeight(ids);

            if (weight <= splitThreshold || prefix.length >= maxDepth) {
                finalGroups[prefix] = ids;
            } else {
                const newSubs = {};
                const exacts = [];
                ids.forEach(id => {
                    if (id.length === prefix.length) exacts.push(id);
                    else {
                        const nextChar = id[prefix.length];
                        const nextPrefix = prefix + nextChar;
                        if (!newSubs[nextPrefix]) newSubs[nextPrefix] = [];
                        newSubs[nextPrefix].push(id);
                    }
                });

                if (Object.keys(newSubs).length > 0) {
                    if (exacts.length > 0) finalGroups[`EXACT_${prefix}`] = exacts;
                    for (const [newPref, newIds] of Object.entries(newSubs)) {
                        queue.push({ prefix: newPref, ids: newIds });
                    }
                } else {
                    finalGroups[`EXACT_${prefix}`] = exacts;
                }
            }
        }

        const chunks = Object.entries(finalGroups).map(([key, ids]) => ({
            val: key.startsWith('EXACT_') ? key.replace('EXACT_', '') : key,
            isExact: key.startsWith('EXACT_'),
            weight: getWeight(ids),
            userCount: ids.length,
            rowCount: getRowCount(ids)
        }));

        chunks.sort((a, b) => {
            const vA = a.val.toLowerCase();
            const vB = b.val.toLowerCase();
            if (vA < vB) return -1;
            if (vA > vB) return 1;
            return 0;
        });

        return chunks;
    }

    // 4. 순차적 할당 (Sequential Packing)
    function packSequentially(chunks, partsCount, startId, ownerTag) {
        const partitions = [];
        let curPart = { id: startId, prefixes: [], exacts: [], weight: 0, userCount: 0, rowCount: 0, owner: ownerTag };
        let remainingWeight = chunks.reduce((sum, c) => sum + c.weight, 0);
        let remainingParts = partsCount;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const dynamicTarget = remainingWeight / remainingParts; 

            if (curPart.weight > 0 && remainingParts > 1 && (curPart.weight + (chunk.weight / 2)) >= dynamicTarget) {
                partitions.push(curPart);
                remainingWeight -= curPart.weight;
                remainingParts--;
                startId++;
                curPart = { id: startId, prefixes: [], exacts: [], weight: 0, userCount: 0, rowCount: 0, owner: ownerTag };
            }

            if (chunk.isExact) curPart.exacts.push(chunk.val);
            else curPart.prefixes.push(chunk.val);
            curPart.weight += chunk.weight;
            curPart.userCount += chunk.userCount;
            curPart.rowCount += chunk.rowCount;
        }
        
        if (curPart.weight > 0 || partitions.length < partsCount) {
            partitions.push(curPart);
        }
        
        while (partitions.length < partsCount) {
            startId++;
            partitions.push({ id: startId, prefixes: [], exacts: [], weight: 0, userCount: 0, rowCount: 0, owner: ownerTag });
        }

        return partitions;
    }

    let finalPartitions = [];
    let globalId = 1;

    // 5. 모드별 파티션 할당
    if (!allowMixing) {
        const populatedCats = majorCategories.filter(cat => categoryGroups[cat].length > 0);
        const totalValidWeight = balanceTarget === 'user' ? totalUniqueUsers : totalValidRows;

        let remainingParts = numPartitions - populatedCats.length;
        if (remainingParts < 0) { numPartitions = populatedCats.length; remainingParts = 0; }

        const allocations = {};
        populatedCats.forEach(cat => allocations[cat] = 1);
        const fractions = populatedCats.map(cat => ({
            cat, exact: (getWeight(categoryGroups[cat]) / totalValidWeight) * remainingParts
        }));

        fractions.sort((a, b) => b.exact - a.exact).forEach(f => {
            const floor = Math.floor(f.exact);
            allocations[f.cat] += floor;
            remainingParts -= floor;
            f.remainder = f.exact - floor;
        });
        fractions.sort((a, b) => b.remainder - a.remainder).forEach((f, i) => {
            if (i < remainingParts) allocations[f.cat]++;
        });

        majorCategories.forEach(cat => {
            if (!allocations[cat]) return;
            const targetCap = Math.ceil(getWeight(categoryGroups[cat]) / allocations[cat]);
            const chunks = drillAndSort({ [cat]: categoryGroups[cat] }, targetCap);
            const packed = packSequentially(chunks, allocations[cat], globalId, cat);
            finalPartitions.push(...packed);
            globalId += allocations[cat];
        });
    } 
    else {
        const targetCap = Math.ceil((balanceTarget === 'user' ? totalUniqueUsers : totalValidRows) / numPartitions);
        const workGroup = {};
        majorCategories.forEach(cat => {
            if (categoryGroups[cat].length > 0) workGroup[cat] = categoryGroups[cat];
        });

        const sortedChunks = drillAndSort(workGroup, targetCap);
        finalPartitions = packSequentially(sortedChunks, numPartitions, globalId, 'Mixed');
    }

    // 6. 쿼리 압축 (Query Compression)
    const allItems = [];
    finalPartitions.forEach(p => {
        allItems.push({ id: p.id, items: [...p.prefixes, ...p.exacts] });
    });

    finalPartitions.forEach(p => {
        const otherItems = [];
        allItems.forEach(otherP => {
            if (otherP.id !== p.id) otherItems.push(...otherP.items);
        });

        const optimizedPrefixes = new Set();
        p.prefixes.forEach(prefix => {
            let bestSafe = prefix;
            for (let i = prefix.length - 1; i >= 1; i--) {
                const candidate = prefix.substring(0, i);
                const hasConflict = otherItems.some(other => 
                    other.startsWith(candidate) || candidate.startsWith(other)
                );
                if (!hasConflict) bestSafe = candidate;
                else break; 
            }
            optimizedPrefixes.add(bestSafe);
        });

        const finalExacts = p.exacts.filter(ex => !Array.from(optimizedPrefixes).some(op => ex.startsWith(op)));
        p.prefixes = Array.from(optimizedPrefixes).sort();
        p.exacts = finalExacts.sort();
    });

    // 7. 도메인 무결성 (Gap Catcher)
    majorCategories.forEach(cat => {
        const usedPrefixes = [];
        const usedExacts = [];

        finalPartitions.forEach(p => {
            p.prefixes.forEach(pre => { if (pre.startsWith(cat)) usedPrefixes.push(pre); });
            p.exacts.forEach(ex => { if (ex.startsWith(cat)) usedExacts.push(ex); });
        });

        if (usedPrefixes.length === 1 && usedPrefixes[0] === cat && usedExacts.length === 0) return;
        if (usedPrefixes.length === 0 && usedExacts.length === 0) return;

        const notClauses = [
            ...usedPrefixes.map(pre => `USER_ID NOT LIKE '${pre}%'`),
            ...usedExacts.map(ex => `USER_ID != '${ex}'`)
        ];

        const gapCatcher = `(
        USER_ID LIKE '${cat}%'
        AND ${notClauses.join('\n        AND ')}
    )`;

        const lastPart = [...finalPartitions].reverse().find(p =>
            p.prefixes.some(pre => pre.startsWith(cat)) || p.exacts.some(ex => ex.startsWith(cat))
        );

        if (lastPart) {
            if (!lastPart.gapCatchers) lastPart.gapCatchers = [];
            lastPart.gapCatchers.push(gapCatcher);
        }
    });

    // 8. 최종 결과 포맷팅
    const result = finalPartitions.map(p => {
        const clauses = [];
        p.prefixes.forEach(val => clauses.push(`USER_ID LIKE '${val}%'`));
        p.exacts.forEach(val => clauses.push(`USER_ID = '${val}'`));
        if (p.gapCatchers) p.gapCatchers.forEach(gc => clauses.push(gc));

        const ownerTag = !allowMixing ? ` (Owner: ${p.owner})` : "";
        return {
            partition_name: `PARTITION_${p.id}${ownerTag}`,
            estimated_users: p.userCount, // [V10] 예상 고유 사용자 수
            estimated_rows: p.rowCount,   // [V10] 예상 데이터(로그) 건수
            query: clauses.length > 0 ? `(
    ${clauses.join('\n    OR ')}
)` : '(1=0)'
        };
    });

    if (includeNotAll) {
        const notClauses = majorCategories.map(cat => `USER_ID NOT LIKE '${cat}%'`);
        result.push({
            partition_name: 'PARTITION_CATCH_ALL',
            estimated_users: categoryGroups['CatchAll'].length,
            estimated_rows: getRowCount(categoryGroups['CatchAll']),
            query: `(
    ${notClauses.join(' AND\n    ')}\n    AND USER_ID != '' AND USER_ID IS NOT NULL
)`
        });
    }

    if (emptyOrNullCount > 0) {
        result.push({
            partition_name: 'PARTITION_EXCEPTION',
            estimated_users: 'N/A',
            estimated_rows: emptyOrNullCount,
            query: "(USER_ID = '' OR USER_ID IS NULL OR TRIM(USER_ID) = '')"
        });
    }

    return result;
}

if (typeof module !== 'undefined' && module.exports) { module.exports = { normalizePartitions }; }
