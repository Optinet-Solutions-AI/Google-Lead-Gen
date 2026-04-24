import sys
import psutil

DEFAULT_PORT = 9222

def kill_port_process(port):
    killed = False
    for proc in psutil.process_iter(['pid', 'name', 'connections']):
        try:
            conns = proc.info['connections']
            if not conns:
                continue
            for conn in conns:
                if conn.laddr.port == port:
                    print(f"Killing process {proc.info['pid']} ({proc.info['name']}) using port {port}")
                    psutil.Process(proc.info['pid']).terminate()
                    killed = True
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue

    if not killed:
        print(f"No process found using port {port}")

if __name__ == "__main__":
    # Concurrent workers each kill their own port: `python3 kill_gologin.py 9223`
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    kill_port_process(port)
