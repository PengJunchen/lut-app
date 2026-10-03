package main

import (
	"fmt"
	"os"
)

var suppressStartupAlerts bool

func reportStartupError(title string, err error) {
	if err == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "%s：%v\n", title, err)
	if !suppressStartupAlerts {
		showStartupError(title, err.Error())
	}
}
