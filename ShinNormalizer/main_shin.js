const fs = require('fs');
const PartitionNormalizer = require('./ShinNormalizer_V10_DualBalance');

const data = fs.readFileSync('input.txt', 'utf8').split('\n');
const rawData = data.filter(x => !(x === '' || x == null));
const majorCategory = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'C'];

const result = PartitionNormalizer.normalizePartitions(rawData, 48, majorCategory, {
    includeNotAll: true, maxDepth: 5, allowMixing: true, granularity: 0.1, balanceTarget: 'user'});

console.log("=== 📈 [정상화 완료 보고서] ===");
result.forEach(p => {
    console.log(p);
});

let text = `Partition Name\tEstimated Accounts\tEstimated Rows\tQuery\n`;
result.forEach(p => {
    text += `${p.partition_name}\t${p.estimated_users}\t${p.estimated_rows}\t${p.query.replaceAll('\n', ' ').replaceAll('    ', '')}\n`;
});

fs.writeFileSync('output.txt', text, 'utf8');