package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// ExportSettings come from the "저장 설정" panel.
type ExportSettings struct {
	Format  string `json:"format"`  // mp3 | m4a | wav | flac
	Quality string `json:"quality"` // 128 | 192 | 320 | lossless
	Folder  string `json:"folder"`
}

func (e *ExportSettings) normalize() {
	e.Format = strings.ToLower(e.Format)
	switch e.Format {
	case "mp3", "m4a", "wav", "flac":
	default:
		e.Format = "mp3"
	}
	switch e.Quality {
	case "128", "192", "320", "lossless":
	default:
		e.Quality = "320"
	}
	if e.Format == "mp3" && e.Quality == "lossless" {
		e.Format = "flac" // MP3에는 무손실이 없어 FLAC으로
	}
	if e.Format == "wav" || e.Format == "flac" {
		e.Quality = "lossless"
	}
	if e.Folder == "" {
		e.Folder = app.resolvedDefaultFolder()
	}
}

// Describe gives a short label such as "MP3 · 320kbps".
func (e ExportSettings) Describe() string {
	q := e.Quality + "kbps"
	if e.Quality == "lossless" {
		q = "무손실"
	}
	if e.Format == "m4a" && e.Quality == "lossless" {
		q = "무손실(ALAC)"
	}
	return strings.ToUpper(e.Format) + " · " + q
}

var (
	aacAtOnce sync.Once
	aacAt     bool
)

// Apple AudioToolbox AAC encoder (better than ffmpeg's native one) when available.
func hasAacAt() bool {
	aacAtOnce.Do(func() {
		out, _ := exec.Command(tool("ffmpeg"), "-hide_banner", "-encoders").Output()
		aacAt = strings.Contains(string(out), "aac_at")
	})
	return aacAt
}

type encodeMeta struct {
	Title, Artist, Album string
	MetaPath             string // source file for tags + cover art
	HasArt               bool
	Bits                 int
	SampleRate           int
}

// encodeTo writes src (any audio ffmpeg reads) to dst using the export settings.
func encodeTo(ctx context.Context, src, dst string, es ExportSettings, m encodeMeta) error {
	try := func(withArt bool) error {
		args := []string{"-v", "error", "-y", "-i", src}
		useMeta := m.MetaPath != "" && fileExists(m.MetaPath)
		if useMeta {
			args = append(args, "-i", m.MetaPath)
		}
		args = append(args, "-map", "0:a:0")
		art := withArt && useMeta && m.HasArt && es.Format != "wav"
		if art {
			args = append(args, "-map", "1:v:0?", "-c:v", "copy", "-disposition:v:0", "attached_pic")
		}
		if useMeta {
			args = append(args, "-map_metadata", "1")
		} else {
			args = append(args, "-map_metadata", "-1")
		}
		if m.Title != "" {
			args = append(args, "-metadata", "title="+m.Title)
		}
		if m.Artist != "" {
			args = append(args, "-metadata", "artist="+m.Artist)
		}
		if m.Album != "" {
			args = append(args, "-metadata", "album="+m.Album)
		}
		args = append(args, "-metadata", "encoded_by=SROAD")
		hi := m.Bits >= 24
		switch es.Format {
		case "mp3":
			args = append(args, "-c:a", "libmp3lame", "-b:a", es.Quality+"k", "-id3v2_version", "3", "-write_id3v1", "1")
			if m.SampleRate > 48000 {
				args = append(args, "-ar", "48000")
			}
		case "m4a":
			if es.Quality == "lossless" {
				args = append(args, "-c:a", "alac")
				if hi {
					args = append(args, "-sample_fmt", "s32p")
				} else {
					args = append(args, "-sample_fmt", "s16p")
				}
			} else {
				if hasAacAt() {
					args = append(args, "-c:a", "aac_at", "-aac_at_mode", "cbr")
				} else {
					args = append(args, "-c:a", "aac")
				}
				args = append(args, "-b:a", es.Quality+"k")
				if m.SampleRate > 48000 {
					args = append(args, "-ar", "48000")
				}
			}
			args = append(args, "-movflags", "+faststart")
		case "wav":
			if hi {
				args = append(args, "-c:a", "pcm_s24le")
			} else {
				args = append(args, "-c:a", "pcm_s16le")
			}
		case "flac":
			args = append(args, "-c:a", "flac", "-compression_level", "8")
			if hi {
				args = append(args, "-sample_fmt", "s32", "-bits_per_raw_sample", "24")
			} else {
				args = append(args, "-sample_fmt", "s16")
			}
		}
		part := dst + ".sroad-part" + filepath.Ext(dst)
		args = append(args, part)
		out, err := exec.CommandContext(ctx, tool("ffmpeg"), args...).CombinedOutput()
		if err != nil {
			os.Remove(part)
			if ctx.Err() != nil {
				return errCanceled
			}
			return fmt.Errorf("인코딩 실패: %s", lastLine(string(out)))
		}
		return os.Rename(part, dst)
	}
	if err := try(true); err != nil {
		if err == errCanceled {
			return err
		}
		return try(false)
	}
	return nil
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndex(s, "\n"); i >= 0 {
		s = s[i+1:]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// saveItem encodes a library item into the export folder.
func saveItem(ctx context.Context, it *Item, es ExportSettings, subdir string) (string, error) {
	es.normalize()
	dir := es.Folder
	if subdir != "" {
		dir = filepath.Join(dir, sanitizeName(subdir))
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("저장 폴더에 쓸 수 없어요: %s", dir)
	}
	dst := uniquePath(dir, it.Base, "."+es.Format)
	title := it.Title
	if title != "" && it.Kind == "result" && it.Label != "" {
		title = fmt.Sprintf("%s (%s)", title, it.Label)
	}
	src := it.Path
	err := encodeTo(ctx, src, dst, es, encodeMeta{
		Title: title, Artist: it.Artist, Album: it.Album,
		MetaPath: it.MetaPath, HasArt: it.HasArt, Bits: it.Bits, SampleRate: it.SampleRate,
	})
	if err != nil {
		return "", err
	}
	return dst, nil
}
