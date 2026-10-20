"""Package only distributable files, then smoke-test without node_modules."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import zipfile
import hashlib

root = Path(__file__).resolve().parents[1]
output = root / 'release-build'
output.mkdir(exist_ok=True)
archive = output / 'gpt-workflow-studio-v0.1.0.zip'
dirs = {'dist', 'server', 'shared', 'web', 'skills', 'examples', 'config', 'scripts', 'tests', '.codex-plugin'}
files = {'plugin.json', 'mcp.json', '.mcp.json', 'package.json', 'pnpm-lock.yaml', '.gitignore', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', '验收记录.md', '界面预览.png', 'THIRD_PARTY_NOTICES.md'}
included = []
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for file in sorted(root.rglob('*')):
        rel = file.relative_to(root)
        if not file.is_file() or '__pycache__' in rel.parts:
            continue
        if rel.parts[0] in dirs or rel.as_posix() in files:
            z.write(file, rel.as_posix())
            included.append(rel.as_posix())

with tempfile.TemporaryDirectory(prefix='workflow-package-') as directory:
    temp = Path(directory).resolve()
    if not temp.is_relative_to(Path(tempfile.gettempdir()).resolve()):
        raise RuntimeError('Temporary extraction location is outside the expected temp root')
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            if not (temp / name).resolve().is_relative_to(temp):
                raise RuntimeError('Unsafe archive entry')
        z.extractall(temp)
    messages = [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'archive-smoke', 'version': '1'}}},
        {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'resources/read', 'params': {'uri': 'ui://gpt-workflow-studio/v1.html'}}
    ]
    p = subprocess.run([shutil.which('node'), str(temp/'dist/server.mjs'), '--stdio', '--data', str(temp/'runtime-data')],
                       cwd=temp, input=''.join(json.dumps(x)+'\n' for x in messages), text=True,
                       encoding='utf-8', capture_output=True, timeout=20)
    if p.returncode:
        raise RuntimeError(p.stderr)
    replies = {x.get('id'): x for line in p.stdout.splitlines() if line.strip() for x in [json.loads(line)]}
    assert replies[1]['result']['serverInfo']['name'] == 'gpt-workflow-studio'
    assert len(replies[2]['result']['tools']) == 10
    assert '序流' in replies[3]['result']['contents'][0]['text']
    assert not (temp/'node_modules').exists()

report = {'archive': archive.name, 'bytes': archive.stat().st_size, 'fileCount': len(included),
          'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'standaloneSmoke': 'passed: extracted bundle runs without node_modules and returns tools and UI', 'files': included}
(output/'SHA256SUMS').write_text(report['sha256']+'  '+archive.name+'\n', encoding='ascii')
(output/'GPT工作流编排台-打包验证.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k != 'files'}, ensure_ascii=False, indent=2))
