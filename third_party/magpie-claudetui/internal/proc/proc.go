// Package proc stands in for magpie's internal/proc: on Linux its Command is exec.Command (the upstream adds
// Windows-only window hiding and WSL handling, which the shim does not build).
package proc

import "os/exec"

func Command(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }
