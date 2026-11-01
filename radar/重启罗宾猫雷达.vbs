Set sh = CreateObject("WScript.Shell")
sh.Run "taskkill /IM electron.exe /F", 0, True
WScript.Sleep 2500
d = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = d
sh.Run """" & d & "\node_modules\electron\dist\electron.exe"" """ & d & """", 1, False
