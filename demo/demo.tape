# Records demo/demo.gif: `vhs demo/demo.tape` from the repository root.
# Needs Node 26+. demo/bin/* are stand-ins for devin, pi and codex, so the
# recording is free and repeatable. The state directory is a temporary one.

Output demo/demo.gif

Set Shell "zsh"
Set FontSize 15
Set Width 1280
Set Height 560
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 30ms

Hide
Type `export PATH="$PWD/demo/bin:$PATH" EXECUTOR_LIMITS_DIR="$(mktemp -d)" PS1='$ '; g() { node src/watchdog.ts -- "$@"; echo "exit code $?"; echo; }; clear`
Enter
Show

Type `g devin -p "fix lint errors"`
Enter
Sleep 4s
Type `g devin -p "refactor the parser"`
Enter
Sleep 6s
Type `g devin -p "run the tests"`
Enter
Sleep 6s
Type `g pi -p "update the docs"`
Enter
Sleep 6s
Sleep 3s
