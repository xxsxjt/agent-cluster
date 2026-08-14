/*
 * hidden-bash.c - 智能体 bash 闪窗根治 wrapper（v3，2026-08-12 中文编码修复）
 *
 * v1 用 CreateProcess + CREATE_NO_WINDOW + STARTF_USESHOWWINDOW(SW_HIDE) 启动 bash，
 * 使 bash 及其派生的所有子进程都不创建可见 conhost 窗口，
 * 同时通过继承的 stdin/stdout/stderr 句柄保持 pi 的 pipe 回传。
 *
 * v3 编码修复（2026-08-12 会话复用 E2E 实证）：
 *   Git bash (msys) 的宽字符 argv → 多字节转换用 C locale，命令行里的中文全部变 '?'，
 *   导致智能体用 bash 写中文内容（DONE/产物）时产生乱码（历史 GBK 乱码 DONE 的根源之一）。
 *   修复：wmain 拿无损 UTF-16 argv → 命令转 UTF-8 → 写入【临时 UTF-8 脚本文件】→ bash <脚本>。
 *   实证：bash 读 UTF-8 脚本字节原样解析执行、输出 UTF-8 正确；仅 argv 通道损坏。
 *   该方案对 pi 透明（pi 仍以 shellPath + -c <command> 调用）。
 *
 * 用法（pi 的 shellPath 指向编译产物 .exe）：
 *   hidden-bash.exe -c <command>
 * 这里仅实现 -c 模式；若非 -c，则把全部参数交给 bash 执行（保持 v1 行为）。
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define MAX_CMD 65536
#define MAX_TMP 1024

static const char *BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/* 随机后缀（伪随机即可，防并发冲突） */
static unsigned long long rand64(void) {
    unsigned long long r = 0;
    int i;
    LARGE_INTEGER pc;
    QueryPerformanceCounter(&pc);
    r = (unsigned long long)pc.QuadPart;
    for (i = 0; i < 4; i++) r = r * 6364136223846793005ULL + 1442695040888963407ULL;
    return r;
}

int wmain(int argc, wchar_t *argv[]) {
    int i;
    char cmdline[MAX_CMD];
    char tmpfile[MAX_TMP];
    wchar_t *command = NULL;      /* -c 的命令（宽字符，编码无损） */
    char commandUtf8[MAX_CMD];    /* 命令转 UTF-8 后写入脚本 */
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    wchar_t wcmd[MAX_CMD];
    DWORD exit_code = 1;
    int start_idx;
    FILE *fp = NULL;
    int use_tmp_script = 0;

    if (argc >= 3 && wcscmp(argv[1], L"-c") == 0) {
        /* -c <command>：command 可能含引号/空格，作为单个参数 */
        command = argv[2];
        start_idx = -1;
        use_tmp_script = 1;   /* v3：命令经临时 UTF-8 脚本执行，绕开 msys argv 转码 */
    } else if (argc >= 2) {
        start_idx = 1;
    } else {
        fprintf(stderr, "hidden-bash: no command\n");
        return 2;
    }

    if (use_tmp_script) {
        /* 构造临时脚本路径：%TEMP%\hb-<pid>-<rand>.sh */
        {
            DWORD tl = GetTempPathW(0, NULL);
            wchar_t *wtmp = (wchar_t *)malloc((tl + 64) * sizeof(wchar_t));
            char tmpdir[MAX_TMP];
            if (!wtmp) return 2;
            GetTempPathW(tl + 1, wtmp);
            WideCharToMultiByte(CP_UTF8, 0, wtmp, -1, tmpdir, MAX_TMP - 64, NULL, NULL);
            free(wtmp);
            snprintf(tmpfile, MAX_TMP, "%shb-%lu-%llu.sh", tmpdir,
                     (unsigned long)GetCurrentProcessId(), rand64());
        }
        /* 命令 UTF-16 → UTF-8（无损；CRT 窄 argv 是 ACP/GBK 会损坏，故用 wmain） */
        {
            int n = WideCharToMultiByte(CP_UTF8, 0, command, -1, commandUtf8, MAX_CMD, NULL, NULL);
            if (n <= 0) { fprintf(stderr, "hidden-bash: cmd utf8 conversion failed\n"); return 2; }
        }
        /* 写 UTF-8 脚本（字节原样，无 BOM；bash 按 UTF-8 解析执行、输出 UTF-8） */
        fp = fopen(tmpfile, "wb");
        if (!fp) { fprintf(stderr, "hidden-bash: cannot create tmp script\n"); return 2; }
        fputs(commandUtf8, fp);
        /* 结尾兜底换行（保证最后一行命令完整执行） */
        if (commandUtf8[0] && commandUtf8[strlen(commandUtf8) - 1] != '\n') fputc('\n', fp);
        fclose(fp);
        /* 执行 bash <脚本>：命令行本身全 ASCII，无转码问题 */
        snprintf(cmdline, sizeof(cmdline), "\"%s\" \"%s\"", BASH, tmpfile);
    } else {
        /* 非 -c 模式：保持 v1 行为（全部参数拼给 bash）——argv 为宽字符，先转 UTF-8 拼接 */
        size_t len = 0;
        size_t cap = sizeof(cmdline);
        cmdline[0] = '\0';
        len += (size_t)snprintf(cmdline, cap, "\"%s\"", BASH);
        for (i = start_idx; i < argc; i++) {
            char argUtf8[MAX_CMD / 4];
            int n = WideCharToMultiByte(CP_UTF8, 0, argv[i], -1, argUtf8, sizeof(argUtf8), NULL, NULL);
            if (n <= 0) continue;
            if (len + 2 >= cap) { cmdline[cap - 1] = '\0'; break; }
            cmdline[len++] = ' ';
            cmdline[len++] = '"';
            for (size_t j = 0; argUtf8[j] != '\0'; j++) {
                if (argUtf8[j] == '"') { cmdline[len++] = '\\'; cmdline[len++] = '"'; }
                else cmdline[len++] = argUtf8[j];
                if (len + 2 >= cap) break;
            }
            cmdline[len++] = '"';
            cmdline[len] = '\0';
        }
        if (len == 0 || len >= cap) { fprintf(stderr, "hidden-bash: command too long\n"); return 2; }
    }

    /* 转宽字符（命令行本身全 ASCII：bash 路径 + 脚本路径） */
    {
        int wlen = MultiByteToWideChar(CP_UTF8, 0, cmdline, -1, NULL, 0);
        if (wlen <= 0 || wlen > MAX_CMD) {
            fprintf(stderr, "hidden-bash: utf8 conversion failed\n");
            goto cleanup;
        }
        MultiByteToWideChar(CP_UTF8, 0, cmdline, -1, wcmd, wlen);
    }

    memset(&si, 0, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    si.wShowWindow = SW_HIDE;   /* 隐藏 bash 控制台窗口 */
    si.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE);

    memset(&pi, 0, sizeof(pi));

    if (!CreateProcessW(
            NULL, wcmd, NULL, NULL, TRUE,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            NULL, NULL, &si, &pi)) {
        fprintf(stderr, "hidden-bash: CreateProcess failed err=%lu\n", (unsigned long)GetLastError());
        goto cleanup;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

cleanup:
    if (use_tmp_script && tmpfile[0]) DeleteFileA(tmpfile);   /* 用完即删 */
    return (int)exit_code;
}
