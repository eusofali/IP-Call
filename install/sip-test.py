#!/usr/bin/env python3
"""SIP reachability test: sends a SIP OPTIONS request over UDP and reports whether the server answers.

  python3 install/sip-test.py sip.icctalk.com            # your provider
  python3 install/sip-test.py sip.linphone.org           # a public SIP server (control test)

Asterisk can keep running: this uses a random local port.
"""
import random, socket, sys, time

host = sys.argv[1] if len(sys.argv) > 1 else 'sip.icctalk.com'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 5060

try:
    ip = socket.gethostbyname(host)
except socket.gaierror as e:
    print(f"DNS FAILED: cannot resolve {host} ({e}). Check /etc/resolv.conf or the server name.")
    sys.exit(2)
print(f"DNS ok: {host} -> {ip}")

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect((ip, port))
local_ip, local_port = s.getsockname()
tag, branch, callid = (random.randint(10**8, 10**9) for _ in range(3))
msg = (f"OPTIONS sip:{host}:{port} SIP/2.0\r\n"
       f"Via: SIP/2.0/UDP {local_ip}:{local_port};branch=z9hG4bK{branch};rport\r\n"
       f"Max-Forwards: 70\r\nFrom: <sip:test@{local_ip}>;tag={tag}\r\nTo: <sip:{host}>\r\n"
       f"Call-ID: {callid}@{local_ip}\r\nCSeq: 1 OPTIONS\r\nContact: <sip:test@{local_ip}:{local_port}>\r\n"
       f"User-Agent: IPCallPanel-sip-test\r\nContent-Length: 0\r\n\r\n")
s.settimeout(3)
for attempt in range(1, 4):
    s.send(msg.encode())
    try:
        data = s.recv(4096).decode(errors='replace')
        print(f"REPLY from {ip}:{port}: {data.splitlines()[0]}")
        server = next((l for l in data.splitlines() if l.lower().startswith(('server:', 'user-agent:'))), None)
        if server:
            print(f"  {server}")
        print("=> The SIP server answers this VPS. If registration still fails, check username/password.")
        sys.exit(0)
    except socket.timeout:
        print(f"attempt {attempt}: no reply")
    except ConnectionRefusedError:
        print(f"attempt {attempt}: port {port} closed (ICMP port unreachable)")
        time.sleep(1)
print(f"=> NO REPLY from {host}:{port} over UDP.")
print("   If a public server (e.g. sip.linphone.org) DOES reply: the provider is ignoring this IP -> ask them to whitelist it.")
print("   If no server replies: your VPS host/firewall blocks SIP (UDP 5060) -> ask the VPS host to open it.")
sys.exit(1)
