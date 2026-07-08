/*
 * sendkeys.exe — WordTaker 微型原生按键注入器（纯 Win32 / user32，无任何脚本引擎依赖）。
 *
 * 背景：企业策略机上 PowerShell 处于 Constrained Language Mode，
 * Add-Type（.NET SendKeys）与 New-Object -ComObject（WScript.Shell）全被禁，
 * clipboard.js 的所有 PowerShell 按键注入路径失效。本工具直接调用 SendInput
 * 派发组合键，作为 Windows 按键注入三级链的最优先路径。
 *
 * 用法：sendkeys.exe paste|copy|selectall
 *   paste     → Ctrl+V
 *   copy      → Ctrl+C
 *   selectall → Ctrl+A
 * 返回值：0 = 成功；1 = SendInput 未完整注入；2 = 参数错误。
 *
 * 注意（UIPI）：若目标前台进程以管理员（更高完整性级别）运行，
 * UIPI 会拦截来自普通权限进程的输入注入——普通应用不受影响，
 * 仅提权窗口收不到按键，属 Windows 安全设计，无需处理。
 *
 * 链接 /SUBSYSTEM:CONSOLE 即可；调用方 spawn 时用 windowsHide:true，不闪窗口。
 * 编译：cl /nologo /O1 /W3 sendkeys.c /Fe:sendkeys.exe /link user32.lib
 */
#include <windows.h>
#include <wchar.h>

/* 派发 Ctrl+<vk>：按下 Ctrl → 按下 vk → 抬起 vk → 抬起 Ctrl（KEYUP 严格配对）。 */
static int send_ctrl_combo(WORD vk)
{
    INPUT in[4];
    ZeroMemory(in, sizeof(in));
    in[0].type = INPUT_KEYBOARD; in[0].ki.wVk = VK_CONTROL;
    in[1].type = INPUT_KEYBOARD; in[1].ki.wVk = vk;
    in[2].type = INPUT_KEYBOARD; in[2].ki.wVk = vk;         in[2].ki.dwFlags = KEYEVENTF_KEYUP;
    in[3].type = INPUT_KEYBOARD; in[3].ki.wVk = VK_CONTROL; in[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return (SendInput(4, in, sizeof(INPUT)) == 4) ? 0 : 1;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc < 2) return 2;
    if (wcscmp(argv[1], L"paste") == 0)     return send_ctrl_combo('V');
    if (wcscmp(argv[1], L"copy") == 0)      return send_ctrl_combo('C');
    if (wcscmp(argv[1], L"selectall") == 0) return send_ctrl_combo('A');
    return 2;
}
