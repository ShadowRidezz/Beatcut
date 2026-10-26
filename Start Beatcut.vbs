' Starts a tiny local web server for Beatcut (hidden window) and opens it in your browser.
' If the server is already running, the second copy just exits and the browser still opens.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "python -m http.server 8796 --bind 127.0.0.1 --directory """ & dir & """", 0, False
WScript.Sleep 1200
sh.Run "http://localhost:8796"
