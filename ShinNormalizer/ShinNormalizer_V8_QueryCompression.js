/**
 * @file ShinNormalizer_V8_QueryCompression.js
 * @description 
 * [정상화의 신 V8.0] 쿼리 압축(Query Compression) 에디션
 * - V7의 마이크로 청킹으로 완벽해진 밸런스를 유지하면서, 
 * - 동일 파티션 내의 불필요하게 잘게 쪼개진 접두사들을 최적의 상위 접두사로 병합(Collapse)합니다.
 */

function normalizePartitions(userIds, numPartitions, majorCategories = [], options = {}) {
    const { 
        includeNotAll = true, 
        maxDepth = 10, 
        allowMixing = false,
        granularity = 0.05 
    } = options;

    const validIds = userIds.filter(id => id && id.toString().trim() !== '');
    const emptyOrNullCount = userIds.length - validIds.length;
    
    const categoryGroups = { 'CatchAll': [] };
    majorCategories.forEach(cat => categoryGroups[cat] = []);

    validIds.forEach(id => {
        const strId = id.toString();
        const matched = majorCategories.find(cat => strId.startsWith(cat));
        if (matched) categoryGroups[matched].push(strId);
        else categoryGroups['CatchAll'].push(strId);
    });

    function drillAndSort(initialGroupMap, targetCapacity) {
        const splitThreshold = Math.max(Math.ceil(targetCapacity * granularity), 100); 
        const finalGroups = {};
        
        const queue = Object.keys(initialGroupMap).map(prefix => ({
            prefix: prefix,
            ids: initialGroupMap[prefix]
        }));

        while (queue.length > 0) {
            const current = queue.shift();
            const prefix = current.prefix;
            const ids = current.ids;

            if (prefix.startsWith('EXACT_')) {
                finalGroups[prefix] = ids;
                continue;
            }

            if (ids.length <= splitThreshold || prefix.length >= maxDepth) {
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
            count: ids.length
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

    function packSequentially(chunks, partsCount, startId, ownerTag) {
        const partitions = [];
        let curPart = { id: startId, prefixes: [], exacts: [], count: 0, owner: ownerTag };
        let remainingData = chunks.reduce((sum, c) => sum + c.count, 0);
        let remainingParts = partsCount;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const dynamicTarget = remainingData / remainingParts; 

            if (curPart.count > 0 && remainingParts > 1 && (curPart.count + (chunk.count / 2)) >= dynamicTarget) {
                partitions.push(curPart);
                remainingData -= curPart.count;
                remainingParts--;
                startId++;
                curPart = { id: startId, prefixes: [], exacts: [], count: 0, owner: ownerTag };
            }

            if (chunk.isExact) curPart.exacts.push(chunk.val);
            else curPart.prefixes.push(chunk.val);
            curPart.count += chunk.count;
        }
        
        if (curPart.count > 0 || partitions.length < partsCount) {
            partitions.push(curPart);
        }
        
        while (partitions.length < partsCount) {
            startId++;
            partitions.push({ id: startId, prefixes: [], exacts: [], count: 0, owner: ownerTag });
        }

        return partitions;
    }

    let finalPartitions = [];
    let globalId = 1;

    if (!allowMixing) {
        const populatedCats = majorCategories.filter(cat => categoryGroups[cat].length > 0);
        const totalValidMajor = populatedCats.reduce((sum, cat) => sum + categoryGroups[cat].length, 0);

        let remainingParts = numPartitions - populatedCats.length;
        if (remainingParts < 0) { numPartitions = populatedCats.length; remainingParts = 0; }

        const allocations = {};
        populatedCats.forEach(cat => allocations[cat] = 1);
        const fractions = populatedCats.map(cat => ({
            cat, exact: (categoryGroups[cat].length / totalValidMajor) * remainingParts
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
            const targetCap = Math.ceil(categoryGroups[cat].length / allocations[cat]);
            const chunks = drillAndSort({ [cat]: categoryGroups[cat] }, targetCap);
            const packed = packSequentially(chunks, allocations[cat], globalId, cat);
            finalPartitions.push(...packed);
            globalId += allocations[cat];
        });
    } 
    else {
        const targetCap = Math.ceil(validIds.length / numPartitions);
        const workGroup = {};
        majorCategories.forEach(cat => {
            if (categoryGroups[cat].length > 0) workGroup[cat] = categoryGroups[cat];
        });

        const sortedChunks = drillAndSort(workGroup, targetCap);
        finalPartitions = packSequentially(sortedChunks, numPartitions, globalId, 'Mixed');
    }

    // ====================================================================
    // [V8.0 핵심] Query Compression (불필요하게 긴 접두사 압축)
    // ====================================================================
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
            // 접두사를 뒤에서부터 하나씩 잘라보며 충돌 검사
            for (let i = prefix.length - 1; i >= 1; i--) {
                const candidate = prefix.substring(0, i);
                
                // 다른 파티션에 candidate를 포함하거나 포함되는 조건이 있는지 확인
                const hasConflict = otherItems.some(other => 
                    other.startsWith(candidate) || candidate.startsWith(other)
                );

                if (!hasConflict) bestSafe = candidate;
                else break; // 충돌 발생 시 그 이상 줄이지 못함
            }
            optimizedPrefixes.add(bestSafe);
        });

        // Exact 조건 중 최적화된 Prefix에 포함되는 것들은 제거
        const finalExacts = p.exacts.filter(ex => {
            return !Array.from(optimizedPrefixes).some(op => ex.startsWith(op));
        });

        p.prefixes = Array.from(optimizedPrefixes).sort();
        p.exacts = finalExacts.sort();
    });

    // ====================================================================
    // [공통] 결과 포맷팅
    // ====================================================================
    const result = finalPartitions.map(p => {
        const clauses = [];
        p.prefixes.forEach(val => clauses.push(`USER_ID LIKE '${val}%'`));
        p.exacts.forEach(val => clauses.push(`USER_ID = '${val}'`));

        const ownerTag = !allowMixing ? ` (Owner: ${p.owner})` : "";
        return {
            partition_name: `PARTITION_${p.id}${ownerTag}`,
            estimated_rows: p.count,
            query: clauses.length > 0 ? `(
    ${clauses.join('\n    OR ')}
)` : '(1=0)'
        };
    });

    if (includeNotAll) {
        const notClauses = majorCategories.map(cat => `USER_ID NOT LIKE '${cat}%'`);
        result.push({
            partition_name: 'PARTITION_CATCH_ALL',
            estimated_rows: categoryGroups['CatchAll'].length,
            query: `(
    ${notClauses.join(' AND\n    ')}\n    AND USER_ID != '' AND USER_ID IS NOT NULL
)`
        });
    }

    if (emptyOrNullCount > 0) {
        result.push({
            partition_name: 'PARTITION_EXCEPTION',
            estimated_rows: emptyOrNullCount,
            query: "(USER_ID = '' OR USER_ID IS NULL OR TRIM(USER_ID) = '')"
        });
    }

    return result;
}

if (typeof module !== 'undefined' && module.exports) { module.exports = { normalizePartitions }; }
