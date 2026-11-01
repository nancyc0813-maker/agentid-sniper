Set sh = CreateObject("WScript.Shell")
d = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = d
sh.Run """" & d & "\node_modules\electron\dist\electron.exe"" """ & d & """", 1, False
