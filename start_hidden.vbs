Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' 走 start_proxy.bat：先设好代理变量再进看门狗循环（这台机器访问 BSC 节点需要代理）
sh.Run "cmd /c start_proxy.bat", 0, False
