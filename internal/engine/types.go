package engine

import "time"

// Look selects the intended Rec.709 LUT style.
type Look string

const (
	LookStandard Look = "standard"
	LookVivid    Look = "vivid"
)

// EncoderMode selects the video encoder. Auto uses VideoToolbox on macOS when
// available, with x265 fallback; other platforms use x265.
type EncoderMode string

const (
	EncoderAuto         EncoderMode = "auto"
	EncoderVideoToolbox EncoderMode = "videotoolbox"
	EncoderX265         EncoderMode = "x265"
)

// Config is the public engine configuration. Manifest entries may be provided
// directly (for embedded UI assets) or loaded from ManifestPath. Relative LUT
// file paths are resolved against LUTDir.
type Config struct {
	Input         string      `json:"input"`
	Output        string      `json:"output,omitempty"`
	Recursive     bool        `json:"recursive"`
	Look          Look        `json:"look,omitempty"`
	FFmpeg        string      `json:"ffmpeg,omitempty"`
	FFprobe       string      `json:"ffprobe,omitempty"`
	LUTDir        string      `json:"lut_dir,omitempty"`
	ManifestPath  string      `json:"manifest_path,omitempty"`
	Manifest      []LUTSpec   `json:"manifest,omitempty"`
	Workers       int         `json:"workers,omitempty"`
	FilterThreads int         `json:"filter_threads,omitempty"`
	Encoder       EncoderMode `json:"encoder,omitempty"`
	CRF           int         `json:"crf,omitempty"`
	Preset        string      `json:"preset,omitempty"`
}

// LUTSpec is a single camera/profile/look mapping from manifest.json.
type LUTSpec struct {
	Camera  string `json:"camera"`
	Profile string `json:"profile"`
	Look    Look   `json:"look"`
	File    string `json:"file"`
	SHA256  string `json:"sha256"`
	Grid    int    `json:"grid"`
}

// Plan is a side-effect-free preview of a batch. Input and output paths on
// items are relative to the selected roots.
type Plan struct {
	InputRoot  string     `json:"input_root"`
	OutputRoot string     `json:"output_root"`
	Look       Look       `json:"look"`
	Items      []ItemPlan `json:"items"`
}

// ItemPlan is the engine's decision for one video.
type ItemPlan struct {
	Input     string `json:"input"`
	Output    string `json:"output"`
	Action    string `json:"action"`
	Status    string `json:"status"`
	Profile   string `json:"profile,omitempty"`
	Camera    string `json:"camera,omitempty"`
	LUTFile   string `json:"lut_file,omitempty"`
	LUTSHA256 string `json:"lut_sha256,omitempty"`
	Gamma     string `json:"source_gamma,omitempty"`
	Encoder   string `json:"encoder,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Bytes     int64  `json:"bytes"`
}

// Event is emitted by Run. Percent is progress for Path; OverallPercent is
// batch progress. Callbacks are serialized by the engine.
type Event struct {
	Type           string      `json:"type"`
	Message        string      `json:"message,omitempty"`
	Path           string      `json:"path,omitempty"`
	Percent        float64     `json:"percent,omitempty"`
	OverallPercent float64     `json:"overall_percent,omitempty"`
	Completed      int         `json:"completed,omitempty"`
	Total          int         `json:"total,omitempty"`
	Item           *ItemReport `json:"item,omitempty"`
}

// ItemReport records the decision and result for one input file.
type ItemReport struct {
	Input           string  `json:"input"`
	Output          string  `json:"output"`
	Action          string  `json:"action"`
	Status          string  `json:"status"`
	Profile         string  `json:"profile,omitempty"`
	Camera          string  `json:"camera,omitempty"`
	LUTFile         string  `json:"lut_file,omitempty"`
	LUTSHA256       string  `json:"lut_sha256,omitempty"`
	SourceGamma     string  `json:"source_gamma,omitempty"`
	Encoder         string  `json:"encoder,omitempty"`
	Reason          string  `json:"reason,omitempty"`
	InputBytes      int64   `json:"input_bytes"`
	OutputBytes     int64   `json:"output_bytes,omitempty"`
	BytesCopied     int64   `json:"bytes_copied,omitempty"`
	InputSHA256     string  `json:"input_sha256,omitempty"`
	OutputSHA256    string  `json:"output_sha256,omitempty"`
	OutputVerified  bool    `json:"output_verified,omitempty"`
	SourceMetadata  string  `json:"source_metadata,omitempty"`
	LogFile         string  `json:"log_file,omitempty"`
	Error           string  `json:"error,omitempty"`
	ConfigKey       string  `json:"config_key,omitempty"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
	NeedsReview     bool    `json:"needs_review,omitempty"`
}

// Summary contains the final per-batch counts.
type Summary struct {
	Total       int `json:"total"`
	Encoded     int `json:"encoded"`
	Copied      int `json:"copied"`
	NeedsReview int `json:"needs_review"`
	Skipped     int `json:"skipped"`
	Failed      int `json:"failed"`
	Cancelled   int `json:"cancelled"`
}

// Report is written to report.json in the selected look output directory.
type Report struct {
	GeneratedBy string       `json:"generated_by"`
	StartedAt   time.Time    `json:"started_at"`
	FinishedAt  time.Time    `json:"finished_at,omitempty"`
	InputRoot   string       `json:"input_root"`
	OutputRoot  string       `json:"output_root"`
	Config      Config       `json:"configuration"`
	Summary     Summary      `json:"summary"`
	Items       []ItemReport `json:"items"`
	History     []ItemReport `json:"history,omitempty"`
}

const (
	ActionCopy   = "copy"
	ActionEncode = "encode"

	StatusPlannedEncode   = "planned_encode"
	StatusCopiedNonLog    = "copied_nonlog"
	StatusCopiedHDR       = "copied_hdr"
	StatusNeedsReview     = "copied_needs_review"
	StatusEncoded         = "encoded"
	StatusSkippedExisting = "skipped_existing"
	StatusFailed          = "failed"
	StatusCancelled       = "cancelled"
)
