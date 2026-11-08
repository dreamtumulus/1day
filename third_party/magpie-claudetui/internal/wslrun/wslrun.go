// Package wslrun stands in for magpie's internal/wslrun: the shim never runs Claude Code inside WSL, so a path maps to itself.
package wslrun

type Tool struct{ Mount string }

func (Tool) Linux(path string) string { return path }
