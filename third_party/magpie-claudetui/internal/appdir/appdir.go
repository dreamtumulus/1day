// Package appdir stands in for magpie's internal/appdir: Getenv without the upstream's path-usability checks.
package appdir

import "os"

func Getenv(name string) string { return os.Getenv(name) }
