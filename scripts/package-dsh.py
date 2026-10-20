from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'legacy/dsh'
manifest = json.loads((source/'source-manifest.json').read_text(encoding='utf-8'))
files = ['README.md', 'source-manifest.json', '验收记录.md']
for entry in manifest['files']:
    file = (source/entry['path']).resolve()
    if not file.is_relative_to(source.resolve()):
        raise RuntimeError('Invalid source path')
    data = file.read_bytes()
    assert len(data) == entry['bytes'], entry['path']
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], entry['path']
    files.append(entry['path'])
dest = root/'releases'
dest.mkdir(exist_ok=True)
archive = dest/'dsh-workflow-studio-v0.3.3.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in files:
        z.write(source/name, name)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
checksums = dest/'SHA256SUMS'
existing = checksums.read_text(encoding='ascii').splitlines() if checksums.exists() else []
checksums.write_text('\n'.join([s for s in existing if not s.endswith('  '+archive.name)]+[checksum+'  '+archive.name])+'\n', encoding='ascii')
report = {'archive':archive.name, 'bytes':archive.stat().st_size, 'sha256':checksum,
          'fileCount':len(files), 'sourceFilesVerified':len(manifest['files']),
          'hostAssertions':242, 'clientAssertions':93, 'actualDshInstallationVerified':False}
(dest/'dsh-package-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
