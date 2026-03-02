const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const defaultSource = path.resolve(projectRoot, '..', '..', 'pcb灯光画图标.png');
const sourceArg = process.argv[2];
const src = sourceArg ? path.resolve(projectRoot, sourceArg) : defaultSource;
const dst = path.resolve(projectRoot, 'images', 'logo.png');

if (!fs.existsSync(src)) {
	process.stderr.write(`Source image not found: ${src}\nUsage: node tools/update-logo.js <relative-or-absolute-path>\n`);
	process.exit(1);
}

fs.copyFileSync(src, dst);
const stat = fs.statSync(dst);
process.stdout.write(`${dst}\n${stat.size}\n`);
