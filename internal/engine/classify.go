package engine

import (
	"fmt"
	"strings"
)

type gammaClassification struct {
	kind    string
	profile string
	raw     string
	reason  string
}

var normalGamma = map[string]bool{
	"normal": true, "normal sdr": true, "rec709": true, "rec.709": true,
	"bt709": true, "bt.709": true, "bt.709 sdr": true, "rec709 sdr": true,
	"itu-r bt.709": true, "itu-r bt.709-6": true,
}

var hdrGamma = map[string]bool{
	"hlg": true, "d-hlg": true, "hybrid log-gamma": true, "arib-std-b67": true,
	"bt2020-hlg": true, "bt.2020 hlg": true, "hdr10": true, "pq": true,
	"st2084": true, "smpte2084": true, "smpte st 2084": true,
	"perceptual quantizer": true, "bt2020-pq": true,
}

func normalizeProfile(label string) string {
	value := strings.ToLower(strings.TrimSpace(label))
	value = strings.NewReplacer(" ", "", "-", "", "_", "", ".", "").Replace(value)
	switch value {
	case "dlog":
		return "dlog"
	case "dlog2":
		return "dlog2"
	case "dlogm":
		return "dlogm"
	default:
		return ""
	}
}

func classifyGamma(probe Probe) gammaClassification {
	values := metadataValues(probe, gammaTag)
	if len(values) == 0 {
		return gammaClassification{kind: "review", reason: "missing exact " + gammaTag + " tag"}
	}
	keys := make(map[string]bool, len(values))
	for _, value := range values {
		key := normalizeProfile(value)
		if key == "" {
			key = strings.NewReplacer(" ", "", "-", "", "_", "", ".", "").Replace(strings.ToLower(strings.TrimSpace(value)))
		}
		keys[key] = true
	}
	if len(keys) != 1 {
		return gammaClassification{kind: "review", raw: strings.Join(values, ", "), reason: fmt.Sprintf("conflicting %s values: %v", gammaTag, values)}
	}
	raw := values[0]
	if profile := normalizeProfile(raw); profile != "" {
		return gammaClassification{kind: "log", profile: profile, raw: raw, reason: "exact DJI gamma mode"}
	}
	token := strings.ToLower(strings.TrimSpace(raw))
	if normalGamma[token] {
		return gammaClassification{kind: "nonlog", raw: raw, reason: fmt.Sprintf("gamma tag %q is in the explicit Normal/Rec.709 allowlist", raw)}
	}
	if hdrGamma[token] {
		return gammaClassification{kind: "hdr", raw: raw, reason: fmt.Sprintf("gamma tag %q explicitly identifies HDR; no LUT applied", raw)}
	}
	return gammaClassification{kind: "review", raw: raw, reason: fmt.Sprintf("unsupported gamma tag %q; no filename/bit-depth inference used", raw)}
}

var cameraLabels = map[string]string{
	"dji osmo pocket 3": "pocket3", "osmo pocket 3": "pocket3", "dji osmopocket3": "pocket3", "osmopocket3": "pocket3",
	"dji osmo action 4": "action4", "osmo action 4": "action4", "dji osmoaction4": "action4", "osmoaction4": "action4",
	"dji osmo action 5 pro": "action5pro", "osmo action 5 pro": "action5pro", "dji osmoaction5pro": "action5pro", "osmoaction5pro": "action5pro",
	"dji osmo action 6": "action6", "osmo action 6": "action6", "dji osmoaction6": "action6", "osmoaction6": "action6",
	"dji mavic 3": "mavic3", "mavic 3": "mavic3", "dji mavic3": "mavic3",
	"dji mavic 2 pro": "mavic2pro", "mavic 2 pro": "mavic2pro", "dji mavic2pro": "mavic2pro",
	"dji air 2s": "air2s", "air 2s": "air2s", "dji air2s": "air2s",
	"dji air 3": "air3", "air 3": "air3", "dji air3": "air3",
	"dji air 3s": "air3s", "air 3s": "air3s", "dji air3s": "air3s",
	"dji osmo pocket 4p": "pocket4p", "osmo pocket 4p": "pocket4p", "dji osmopocket4p": "pocket4p", "osmopocket4p": "pocket4p",
}

var encoderLabels = map[string]string{
	"dji osmopocket4p":  "pocket4p",
	"dji osmo pocket 3": "pocket3", "dji osmopocket3": "pocket3",
	"dji osmo action 4": "action4", "dji osmoaction4": "action4",
	"dji osmo action 5 pro": "action5pro", "dji osmoaction5pro": "action5pro",
	"dji osmo action 6": "action6", "dji osmoaction6": "action6",
	"dji mavic 3": "mavic3", "dji mavic 2 pro": "mavic2pro",
	"dji air 2s": "air2s", "dji air 3": "air3", "dji air 3s": "air3s",
}

func canonicalLabel(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
}

func resolveCamera(probe Probe) (string, string, error) {
	models := semanticCameraValues(metadataValues(probe, cameraModelTag))
	encoders := semanticCameraValues(metadataValues(probe, "encoder"))
	modelCamera, modelUnknown, err := evidenceCamera(models, cameraLabels)
	if err != nil {
		return "", "", err
	}
	encoderCamera, encoderUnknown, err := evidenceCamera(encoders, encoderLabels)
	if err != nil {
		return "", "", err
	}
	if modelCamera != "" && encoderCamera != "" && modelCamera != encoderCamera {
		return "", "", fmt.Errorf("camera model and encoder metadata conflict (%s vs %s)", modelCamera, encoderCamera)
	}
	if modelCamera == "pocket4p" && len(models) == 1 && strings.EqualFold(models[0], "PP-041") {
		if len(encoders) != 1 || !strings.EqualFold(encoders[0], "DJI OsmoPocket4P") {
			return "", "", fmt.Errorf("Pocket 4P automatic selection requires exact CameraModel=PP-041 and encoder=DJI OsmoPocket4P together")
		}
		return "pocket4p", "metadata_pair", nil
	}
	if modelCamera != "" {
		return modelCamera, "exact_model", nil
	}
	if encoderCamera != "" {
		return encoderCamera, "exact_encoder", nil
	}
	if modelUnknown || encoderUnknown {
		return "", "", fmt.Errorf("camera identity is unknown; exact model or known original encoder metadata is required")
	}
	return "", "", fmt.Errorf("camera model and encoder metadata are missing")
}

func evidenceCamera(values []string, registry map[string]string) (camera string, unknown bool, err error) {
	if len(values) > 1 {
		return "", false, fmt.Errorf("conflicting camera metadata values: %v", values)
	}
	if len(values) == 0 {
		return "", false, nil
	}
	value := canonicalLabel(values[0])
	if value == "pp-041" {
		return "pocket4p", false, nil
	}
	if camera = registry[value]; camera != "" {
		return camera, false, nil
	}
	compact := compactCameraLabel(value)
	for label, candidate := range registry {
		if compactCameraLabel(label) == compact {
			return candidate, false, nil
		}
	}
	return "", true, nil
}

func compactCameraLabel(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.NewReplacer(" ", "", "-", "", "_", "").Replace(value)
}

func semanticCameraValues(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		key := compactCameraLabel(value)
		if !seen[key] {
			seen[key] = true
			out = append(out, value)
		}
	}
	return out
}
