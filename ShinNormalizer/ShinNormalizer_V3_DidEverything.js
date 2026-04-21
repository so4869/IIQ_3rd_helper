/**
 * 진·정상화 (V3.0): 데이터 편향 자동 감지 및 동적 세분화 (Auto-Split)
 * @param {string[]} userIds - 원본 데이터 배열
 * @param {number} numPartitions - 목표 파티션 개수 (예: 36)
 * @param {string[]} majorCategories - 대분류 조건 배열 (예: ['0','1',...'9','C'])
 * @param {boolean} includeNotAll - Catch-all 포함 여부
 */
function normalizePartitionsAutoSplit(userIds, numPartitions, majorCategories, includeNotAll = true) {
    const validIds = userIds.filter(id => id && id.toString().trim() !== '');
    const emptyOrNullCount = userIds.length - validIds.length;

    // 파티션 1개당 감당해야 할 목표 적정 데이터 수 (15% 정도의 오버플로우는 허용)
    const targetCapacity = Math.ceil(validIds.length / numPartitions);
    const splitThreshold = targetCapacity * 1.15;

    // 카테고리별 데이터 묶음 (초기에는 대분류와 Catch-all로 시작)
    let categoryGroups = { 'CatchAll': [] };
    majorCategories.forEach(cat => categoryGroups[cat] = []);

    // 1. 대분류 기준으로 1차 분류
    validIds.forEach(id => {
        const strId = id.toString();
        const matched = majorCategories.find(cat => strId.startsWith(cat));
        if (matched) categoryGroups[matched].push(strId);
        else categoryGroups['CatchAll'].push(strId);
    });

    // 2. 동적 세분화 (Drill-down) 루프: 데이터가 임계치를 넘으면 스스로 쪼갬
    let canSplitMore = true;
    const maxDepth = 10; // 무한 루프 방지용 최대 깊이 제한

    while (canSplitMore) {
        canSplitMore = false;
        const currentPrefixes = Object.keys(categoryGroups);

        for (const prefix of currentPrefixes) {
            if (prefix === 'CatchAll') continue; // CatchAll은 분할하지 않고 묶어둠

            const ids = categoryGroups[prefix];
            // 해당 접두사에 데이터가 너무 많고, 최대 깊이에 도달하지 않았다면 분할 시도!
            if (ids.length > splitThreshold && prefix.length < maxDepth) {
                const newSubGroups = {};
                const exactMatches = []; // 정확히 길이가 일치하는 ID (더 쪼갤 수 없음)

                ids.forEach(id => {
                    if (id.length === prefix.length) {
                        exactMatches.push(id);
                    } else {
                        // 스스로 다음 문자를 파악해서 새로운 접두사 생성!
                        const nextChar = id[prefix.length];
                        const newPrefix = prefix + nextChar;
                        if (!newSubGroups[newPrefix]) newSubGroups[newPrefix] = [];
                        newSubGroups[newPrefix].push(id);
                    }
                });

                // 실제로 쪼개졌다면 기존 그룹을 파기하고 새 그룹들을 등록
                if (Object.keys(newSubGroups).length > 0) {
                    delete categoryGroups[prefix];

                    if (exactMatches.length > 0) {
                        categoryGroups[`EXACT_${prefix}`] = exactMatches; // EXACT_ 마커 추가
                    }

                    for (const [newPref, newIds] of Object.entries(newSubGroups)) {
                        categoryGroups[newPref] = newIds;
                    }

                    canSplitMore = true; // 쪼개진 녀석들이 또 초과하는지 다시 검사하기 위해 true
                    break;
                }
            }
        }
    }

    // 3. 탐욕 알고리즘으로 분배 (잘게 쪼개진 조각들을 바구니에 담기)
    const sortedGroups = Object.entries(categoryGroups)
        .filter(([prefix]) => prefix !== 'CatchAll')
        .sort((a, b) => b[1].length - a[1].length); // 데이터가 많은 조각부터 정렬

    const partitions = Array.from({ length: numPartitions }, (_, i) => ({
        id: i + 1, prefixes: [], exacts: [], totalCount: 0
    }));

    sortedGroups.forEach(([prefix, ids]) => {
        let target = partitions.reduce((minP, p) => p.totalCount < minP.totalCount ? p : minP, partitions[0]);
        if (prefix.startsWith('EXACT_')) {
            target.exacts.push(prefix.replace('EXACT_', ''));
        } else {
            target.prefixes.push(prefix);
        }
        target.totalCount += ids.length;
    });

    // 4. 결과 출력 포맷팅
    const result = partitions.sort((a, b) => a.id - b.id).map(p => {
        p.prefixes.sort();
        const clauses = [];
        // 일반 LIKE 조건
        if (p.prefixes.length > 0) clauses.push(...p.prefixes.map(pref => `USER_ID LIKE '${pref}%'`));
        // 더 쪼갤 수 없는 정확한 일치 조건
        if (p.exacts.length > 0) clauses.push(...p.exacts.map(ex => `USER_ID = '${ex}'`));

        return {
            partition_name: `PARTITION_${p.id}`,
            estimated_rows: p.totalCount,
            query: clauses.length > 0 ? `(\n    ${clauses.join('\n    OR ')}\n)` : '(1=0)'
        };
    });

    // 5. Catch-all (대분류 외)
    if (includeNotAll && categoryGroups['CatchAll'].length > 0) {
        const notClauses = majorCategories.map(cat => `USER_ID NOT LIKE '${cat}%'`);
        result.push({
            partition_name: `PARTITION_CATCH_ALL`,
            estimated_rows: categoryGroups['CatchAll'].length,
            query: `(\n    ${notClauses.join(' AND\n    ')}\n    AND USER_ID != '' AND USER_ID IS NOT NULL\n)`
        });
    }

    // 6. 공백/NULL 격리
    if (emptyOrNullCount > 0) {
        result.push({ partition_name: `PARTITION_EXCEPTION`, estimated_rows: emptyOrNullCount, query: `(...)` });
    }

    return result;
}