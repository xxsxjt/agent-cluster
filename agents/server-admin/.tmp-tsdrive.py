#!/usr/bin/env python3
"""Drive TShock.Server's interactive console over a pty with an expect script.

usage:
  tsdrive.py <logfile> <timeout_s> <steps_json> -- <abs_server_path> [args...]

steps_json is a JSON list of [regex, response] pairs, matched in order against
the tail of the output stream; each response is sent with a trailing newline
("" sends a bare Enter). Pass [] to only observe the prompts.

Always terminates the child before exiting (SIGTERM, then SIGKILL) so no orphan
server is left holding a world file -- see knowledge/pitfalls.md.
"""
import json
import os
import pty
import pwd
import re
import select
import signal
import sys
import time

RUN_AS = "terraria"
WORKDIR = "/data/terraria/tshock"
CHILD_ENV = {
    "HOME": "/data/terraria",
    "DOTNET_BUNDLE_EXTRACT_BASE_DIR": "/data/terraria/.net",
    "XDG_CACHE_HOME": "/data/terraria/.cache",
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "TERM": "dumb",
    "LANG": "en_US.UTF-8",
}


def say(log, msg):
    line = "\n<<< %s >>>\n" % msg
    sys.stdout.write(line)
    sys.stdout.flush()
    log.write(line.encode())
    log.flush()


def spawn(args):
    pw = pwd.getpwnam(RUN_AS)
    os.chdir(WORKDIR)
    pid, fd = pty.fork()
    if pid == 0:
        os.setgid(pw.pw_gid)
        os.setgroups([])
        os.setuid(pw.pw_uid)
        try:
            os.execve(args[0], args, CHILD_ENV)
        except Exception:
            pass
        os._exit(127)
    return pid, fd
def reap(pid, log):
    """SIGTERM then SIGKILL; never leave the child running."""
    for sig, grace in ((signal.SIGTERM, 40), (signal.SIGKILL, 5)):
        try:
            os.kill(pid, 0)
        except OSError:
            return
        say(log, "sending %s to pid %d" % (sig.name, pid))
        try:
            os.kill(pid, sig)
        except OSError:
            return
        for _ in range(grace):
            time.sleep(1)
            try:
                gone, _st = os.waitpid(pid, os.WNOHANG)
            except OSError:
                return
            if gone == pid:
                say(log, "child exited after %s" % sig.name)
                return


def main():
    logpath, timeout, steps_json = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    args = sys.argv[sys.argv.index("--") + 1:]
    steps = [(re.compile(p, re.I), r) for p, r in json.loads(steps_json)]

    log = open(logpath, "wb")
    pid, fd = spawn(args)
    say(log, "spawned pid=%d argv=%r" % (pid, args))

    buf = ""
    idx = 0
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            if not select.select([fd], [], [], 1.0)[0]:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            log.write(data)
            log.flush()
            text = data.decode("utf-8", "replace")
            sys.stdout.write(text)
            sys.stdout.flush()
            buf += text

            # fire at most one step per read, in declared order
            while idx < len(steps):
                pat, resp = steps[idx]
                if not pat.search(buf):
                    break
                say(log, "step %d matched /%s/ -> send %r" % (idx, pat.pattern, resp))
                os.write(fd, (resp + "\n").encode())
                idx += 1
                buf = ""
                time.sleep(0.4)
        else:
            say(log, "TIMEOUT after %ss" % timeout)
    finally:
        say(log, "steps fired: %d/%d" % (idx, len(steps)))
        reap(pid, log)
        log.close()


if __name__ == "__main__":
    main()
