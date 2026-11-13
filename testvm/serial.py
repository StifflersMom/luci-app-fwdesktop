import socket,sys,time
s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.settimeout(0.5)
def rd(t):
    out=b'';end=time.time()+t
    while time.time()<end:
        try:
            d=s.recv(4096)
            if d: out+=d
        except socket.timeout: pass
    return out.decode(errors='replace')
for cmd in sys.argv[2:]:
    s.send(cmd.encode()+b'\n'); print(rd(3),end='')
