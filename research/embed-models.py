"""Keep inference data available without an optional static-asset binding."""
from pathlib import Path
import base64,gzip,hashlib
root=Path(__file__).resolve().parents[1]
lines=['// Generated numeric research models; see research/model-provenance.json.']
for variable,file in [('MODEL_GZIP_B64','research-v1.json'),('DEMO_GZIP_B64','demo-state.json')]:
    raw=(root/'public/models'/file).read_bytes()
    payload=base64.b64encode(gzip.compress(raw,mtime=0)).decode('ascii')
    lines.extend([f'// {file} SHA256 {hashlib.sha256(raw).hexdigest()}',f'export const {variable}="{payload}";'])
(root/'lib/embedded-models.ts').write_text('\n'.join(lines)+'\n')
print('Embedded research model and isolated synthetic demo')
