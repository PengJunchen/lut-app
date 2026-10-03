package engine

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var videoExtensions = map[string]bool{
	".3g2": true, ".3gp": true, ".3gp2": true, ".asf": true, ".avi": true, ".divx": true,
	".f4v": true, ".flv": true, ".m1v": true, ".m2t": true, ".m2ts": true, ".m2v": true,
	".m4v": true, ".mkv": true, ".mov": true, ".mp2": true, ".mp4": true, ".mpe": true,
	".mpeg": true, ".mpg": true, ".mts": true, ".mxf": true, ".ogm": true, ".ogv": true,
	".rm": true, ".rmvb": true, ".ts": true, ".vob": true, ".webm": true, ".wmv": true,
	".y4m": true,
}

var lrfToken = regexp.MustCompile(`(?i)(^|[._-])LRF($|[._-])`)

func discoverVideos(cfg normalizedConfig) ([]string, error) {
	var files []string
	input := cfg.inputAbs
	if managedOutputDirectory(input) {
		return files, nil
	}
	excluded := []string{cfg.baseOutput, cfg.outputRoot, cfg.lutDirAbs}
	shouldExclude := func(path string, isDir bool) bool {
		rel, err := filepath.Rel(input, path)
		if err == nil {
			for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
				if strings.HasPrefix(part, ".") {
					return true
				}
				if strings.EqualFold(part, "luts") {
					return true
				}
			}
		}
		for _, root := range excluded {
			if samePath(path, root) || isAncestor(root, path) {
				return true
			}
		}
		directory := path
		if !isDir {
			directory = filepath.Dir(path)
		}
		for !samePath(directory, input) && isAncestor(input, directory) {
			if managedOutputDirectory(directory) {
				return true
			}
			directory = filepath.Dir(directory)
		}
		return false
	}
	if !cfg.Recursive {
		entries, err := os.ReadDir(input)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || shouldExclude(filepath.Join(input, entry.Name()), false) || !videoCandidate(entry.Name()) {
				continue
			}
			files = append(files, filepath.Join(input, entry.Name()))
		}
	} else {
		err := filepath.WalkDir(input, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if samePath(path, input) {
				return nil
			}
			if entry.IsDir() {
				if shouldExclude(path, true) {
					return filepath.SkipDir
				}
				return nil
			}
			if !entry.Type().IsRegular() || shouldExclude(path, false) || !videoCandidate(entry.Name()) {
				return nil
			}
			files = append(files, path)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sortPathsByRelative(files, input)
	return files, nil
}

func videoCandidate(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") {
		return false
	}
	ext := strings.ToLower(filepath.Ext(name))
	if !videoExtensions[ext] || ext == ".lrf" {
		return false
	}
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	return !lrfToken.MatchString(stem)
}

func managedOutputDirectory(path string) bool {
	data, err := os.ReadFile(filepath.Join(path, "report.json"))
	if err != nil {
		return false
	}
	var header struct {
		GeneratedBy string `json:"generated_by"`
	}
	if json.Unmarshal(data, &header) != nil {
		return false
	}
	return strings.HasPrefix(header.GeneratedBy, "dji-lut-app/")
}

func sortPathsByRelative(paths []string, root string) {
	// Discovery order is made deterministic without relying on filesystem order.
	sort.Slice(paths, func(i, j int) bool {
		a, _ := filepath.Rel(root, paths[i])
		b, _ := filepath.Rel(root, paths[j])
		return strings.ToLower(filepath.ToSlash(a)) < strings.ToLower(filepath.ToSlash(b))
	})
}
