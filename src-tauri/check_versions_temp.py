
import json, subprocess, sys
def v(p, i):
    r = subprocess.run([sys.executable, "-m", "pip", "show", p], stdout=subprocess.PIPE, text=True)
    for l in r.stdout.splitlines():
        if l.lower().startswith("version:"): return l.split(":",1)[1].strip()
    try:
        return __import__(i).__version__
    except: return "not installed"
print(json.dumps({"rvc-python":v("rvc-python","rvc"),"edge-tts":v("edge-tts","edge_tts"),"torch":v("torch","torch"),"torchaudio":v("torchaudio","torchaudio")}, indent=2))
