# -*- coding: utf-8 -*-
"""CNB 构建任务带环境自愈标记重派验证 - 辅助工具（处理 UTF-8 文件名）"""
import os, sys, glob

INBOX = r"C:/Users/du_ji/pi_workspace/org/inbox"
TASK_BASE = "nextday-2026-08-11-CNB-构建任务带环境自愈标记重派验证-152618"

def find_task_files():
    """在 inbox 中找到本任务相关文件"""
    hits = [f for f in os.listdir(INBOX) if TASK_BASE in f]
    return hits

def show():
    hits = find_task_files()
    for h in hits:
        p = os.path.join(INBOX, h)
        print("="*20, h, "="*20)
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                print(f.read())

def write_done(summary):
    """写 DONE 标记文件"""
    p = os.path.join(INBOX, TASK_BASE + ".DONE")
    with open(p, "w", encoding="utf-8") as f:
        f.write(summary)
    print("DONE 已写入:", p)

def remove_pid():
    p = os.path.join(INBOX, TASK_BASE + ".PID")
    if os.path.exists(p):
        os.remove(p)
        print("PID 已删除:", p)
    else:
        print("PID 不存在（无需删除）")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "show":
        show()
    elif cmd == "done":
        summary = sys.argv[2] if len(sys.argv) > 2 else "DONE"
        write_done(summary)
    elif cmd == "rmpid":
        remove_pid()
    else:
        print("unknown cmd:", cmd)
