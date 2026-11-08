// cc-tui-shim runs Claude Code's interactive mode for the 1dayAPI provider node (docs/tui-worker-2026-11-08.md).
//
// The node talks to it exactly as it talks to `claude -p --input-format stream-json --output-format stream-json`;
// the shim rewrites those arguments into the interactive mode's, runs the real interactive Claude Code in a
// pseudo-terminal, pastes each user message, tails the session transcript and streams replies through the tap.
//
// The implementation is magpie's internal/claudetui (MIT, yetone), vendored verbatim under internal/claudetui and
// re-synced with ../sync.sh; only names and two small behaviours are patched (see ../patches).
package main

import (
	"fmt"
	"os"

	"1dayapi.com/cc-tui-shim/internal/claudetui"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-V") {
		fmt.Println("cc-tui-shim " + version + " (claudetui upstream " + upstream + ")")
		return
	}
	if err := claudetui.Run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// version and upstream are stamped by sync.sh / the build (-ldflags "-X main.version=… -X main.upstream=…").
var version, upstream = "dev", "unknown"
