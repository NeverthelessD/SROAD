package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Item is a song in the library: either an uploaded source or a result made from one.
type Item struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`  // file name shown to the user (with extension)
	Title      string    `json:"title"` // tag title, if any
	Artist     string    `json:"artist"`
	Album      string    `json:"album"`
	Ext        string    `json:"ext"`
	Codec      string    `json:"codec"`
	Duration   float64   `json:"duration"`
	SampleRate int       `json:"sampleRate"`
	Channels   int       `json:"channels"`
	Bitrate    int       `json:"bitrate"`
	Bits       int       `json:"bits"`
	Size       int64     `json:"size"`
	HasArt     bool      `json:"hasArt"`
	Kind       string    `json:"kind"` // source | result
	ParentID   string    `json:"parentId,omitempty"`
	RootID     string    `json:"rootId"`
	Mode       string    `json:"mode,omitempty"` // vocal | track | pitch | tempo | edit
	Label      string    `json:"label,omitempty"`
	Stem       string    `json:"stem,omitempty"`
	Peaks      []float32 `json:"peaks"`
	Created    int64     `json:"created"`
	SavedPath  string    `json:"savedPath,omitempty"`
	Base       string    `json:"base"` // file-name stem used for outputs

	Path     string `json:"-"`
	MetaPath string `json:"-"` // file that carries tags / cover art for outputs
}

type Library struct {
	mu    sync.Mutex
	dir   string
	items map[string]*Item
	order []string
	rev   int64
}

func NewLibrary(dir string) *Library {
	return &Library{dir: dir, items: map[string]*Item{}, rev: 1}
}

type savedItem struct {
	Item
	P  string `json:"_path"`
	MP string `json:"_meta"`
}

func (l *Library) Save() {
	l.mu.Lock()
	defer l.mu.Unlock()
	var list []savedItem
	for _, id := range l.order {
		it := l.items[id]
		list = append(list, savedItem{*it, it.Path, it.MetaPath})
	}
	b, _ := json.Marshal(list)
	writeFileAtomic(filepath.Join(l.dir, "library.json"), b, 0o644)
}

func (l *Library) Load() {
	b, err := os.ReadFile(filepath.Join(l.dir, "library.json"))
	if err != nil {
		return
	}
	var list []savedItem
	if json.Unmarshal(b, &list) != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, s := range list {
		it := s.Item
		it.Path, it.MetaPath = s.P, s.MP
		if !fileExists(it.Path) {
			continue
		}
		l.items[it.ID] = &it
		l.order = append(l.order, it.ID)
	}
	l.rev++
}

func (l *Library) touch() { l.rev++ }

func (l *Library) Add(it *Item) {
	l.mu.Lock()
	l.items[it.ID] = it
	l.order = append(l.order, it.ID)
	l.touch()
	l.mu.Unlock()
	go l.Save()
}

func (l *Library) Get(id string) *Item {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.items[id]
}

func (l *Library) Update(id string, fn func(*Item)) {
	l.mu.Lock()
	if it := l.items[id]; it != nil {
		fn(it)
		l.touch()
	}
	l.mu.Unlock()
	go l.Save()
}

// Remove deletes items and every result derived from them.
func (l *Library) Remove(ids []string) {
	l.mu.Lock()
	kill := map[string]bool{}
	for _, id := range ids {
		kill[id] = true
	}
	for changed := true; changed; {
		changed = false
		for _, it := range l.items {
			if !kill[it.ID] && kill[it.ParentID] {
				kill[it.ID] = true
				changed = true
			}
		}
	}
	var keep []string
	for _, id := range l.order {
		if kill[id] {
			if it := l.items[id]; it != nil {
				matches, _ := filepath.Glob(filepath.Join(l.dir, id+"*"))
				for _, m := range matches {
					os.RemoveAll(m)
				}
			}
			delete(l.items, id)
		} else {
			keep = append(keep, id)
		}
	}
	l.order = keep
	l.touch()
	l.mu.Unlock()
	go l.Save()
}

func (l *Library) SnapshotIfChanged(since int64) (int64, []Item) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if since == l.rev {
		return l.rev, nil
	}
	out := make([]Item, 0, len(l.order))
	for _, id := range l.order {
		out = append(out, *l.items[id])
	}
	return l.rev, out
}

// ---------------------------------------------------------------- ffprobe

type probeInfo struct {
	Streams []struct {
		CodecType     string            `json:"codec_type"`
		CodecName     string            `json:"codec_name"`
		SampleRate    string            `json:"sample_rate"`
		Channels      int               `json:"channels"`
		BitRate       string            `json:"bit_rate"`
		BitsPerRaw    string            `json:"bits_per_raw_sample"`
		BitsPerSample int               `json:"bits_per_sample"`
		SampleFmt     string            `json:"sample_fmt"`
		Disposition   map[string]int    `json:"disposition"`
		Tags          map[string]string `json:"tags"`
	} `json:"streams"`
	Format struct {
		Duration string            `json:"duration"`
		BitRate  string            `json:"bit_rate"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
}

func tool(name string) string {
	exe := name
	if strings.HasSuffix(os.Args[0], ".exe") {
		exe += ".exe"
	}
	if d := os.Getenv("SROAD_FFMPEG_DIR"); d != "" && (name == "ffmpeg" || name == "ffprobe") {
		return filepath.Join(d, exe)
	}
	return filepath.Join(app.binDir, exe)
}

func probe(path string) (*Item, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, tool("ffprobe"), "-v", "error", "-print_format", "json",
		"-show_format", "-show_streams", path).Output()
	if err != nil {
		return nil, fmt.Errorf("음원 정보를 읽을 수 없어요")
	}
	var p probeInfo
	if err := json.Unmarshal(out, &p); err != nil {
		return nil, err
	}
	it := &Item{}
	found := false
	for _, s := range p.Streams {
		if s.CodecType == "audio" && !found {
			found = true
			it.Codec = s.CodecName
			it.SampleRate, _ = strconv.Atoi(s.SampleRate)
			it.Channels = s.Channels
			it.Bitrate, _ = strconv.Atoi(s.BitRate)
			it.Bits, _ = strconv.Atoi(s.BitsPerRaw)
			if it.Bits == 0 {
				it.Bits = s.BitsPerSample
			}
			if it.Bits == 0 && strings.HasPrefix(s.SampleFmt, "s32") {
				it.Bits = 24
			}
		}
		if s.CodecType == "video" && s.Disposition["attached_pic"] == 1 {
			it.HasArt = true
		}
	}
	if !found {
		return nil, fmt.Errorf("소리가 들어 있지 않은 파일이에요")
	}
	it.Duration, _ = strconv.ParseFloat(p.Format.Duration, 64)
	if it.Bitrate == 0 {
		it.Bitrate, _ = strconv.Atoi(p.Format.BitRate)
	}
	tags := map[string]string{}
	for k, v := range p.Format.Tags {
		tags[strings.ToLower(k)] = v
	}
	for _, s := range p.Streams {
		if s.CodecType == "audio" {
			for k, v := range s.Tags {
				if _, ok := tags[strings.ToLower(k)]; !ok {
					tags[strings.ToLower(k)] = v
				}
			}
		}
	}
	it.Title, it.Artist, it.Album = tags["title"], tags["artist"], tags["album"]
	if it.Duration <= 0 {
		return nil, fmt.Errorf("길이를 알 수 없는 음원이에요")
	}
	return it, nil
}

// peaks returns n peak values (0..1) for a mini waveform.
func peaks(path string, n int) []float32 {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool("ffmpeg"), "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "2000",
		"-f", "s16le", "-acodec", "pcm_s16le", "-")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if cmd.Start() != nil {
		return nil
	}
	var samples []int16
	r := bufio.NewReaderSize(out, 1<<16)
	buf := make([]byte, 2)
	for {
		if _, err := io.ReadFull(r, buf); err != nil {
			break
		}
		samples = append(samples, int16(binary.LittleEndian.Uint16(buf)))
	}
	cmd.Wait()
	res := make([]float32, n)
	if len(samples) == 0 {
		return res
	}
	var mx float32
	for i := 0; i < n; i++ {
		a := i * len(samples) / n
		b := (i + 1) * len(samples) / n
		if b <= a {
			b = a + 1
		}
		var m int32
		for _, s := range samples[a:min(b, len(samples))] {
			v := int32(s)
			if v < 0 {
				v = -v
			}
			if v > m {
				m = v
			}
		}
		res[i] = float32(m) / 32768
		if res[i] > mx {
			mx = res[i]
		}
	}
	if mx > 0 {
		for i := range res {
			res[i] = float32(math.Sqrt(float64(res[i] / mx)))
		}
	}
	return res
}

// ---------------------------------------------------------------- handlers

var audioExt = map[string]bool{"mp3": true, "wav": true, "flac": true, "m4a": true, "aac": true, "aif": true, "aiff": true,
	"ogg": true, "opus": true, "wma": true, "alac": true, "caf": true, "mp4": true, "webm": true}

func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, 405, "POST only")
		return
	}
	if !a.setup.ToolsReady() {
		jsonError(w, 503, "먼저 AI 엔진 설치를 마쳐 주세요")
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "audio"
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	id := randID(8)
	safe := ext
	if !audioExt[safe] {
		safe = "bin"
	}
	path := filepath.Join(a.workDir, id+"-src."+safe)
	f, err := os.Create(path)
	if err != nil {
		jsonError(w, 500, "임시 파일을 만들 수 없어요")
		return
	}
	n, err := io.Copy(f, r.Body)
	f.Close()
	if err != nil {
		os.Remove(path)
		jsonError(w, 500, "파일을 받지 못했어요")
		return
	}
	it, err := probe(path)
	if err != nil {
		os.Remove(path)
		jsonError(w, 415, name+": "+err.Error())
		return
	}
	it.ID, it.Name, it.Ext, it.Size = id, name, ext, n
	it.Kind, it.RootID = "source", id
	it.Base = sanitizeName(strings.TrimSuffix(name, filepath.Ext(name)))
	if it.Base == "" {
		it.Base = "audio"
	}
	it.Path, it.MetaPath = path, path
	it.Created = time.Now().UnixMilli()
	it.Peaks = peaks(path, 240)
	a.lib.Add(it)
	writeJSON(w, map[string]any{"ok": true, "item": it})
}

func (a *App) handleRemove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if readJSON(r, &in) != nil {
		jsonError(w, 400, "bad request")
		return
	}
	a.lib.Remove(in.IDs)
	writeJSON(w, map[string]any{"ok": true})
}

var nativePlayable = map[string]bool{"mp3": true, "flac": true, "pcm_s16le": true, "pcm_s24le": true, "pcm_f32le": true, "aac": true, "vorbis": true, "opus": true}

// /api/stream?id=…&wav=1 — audio for <audio> elements (original file when the browser can play it).
func (a *App) handleStream(w http.ResponseWriter, r *http.Request) {
	it := a.lib.Get(r.URL.Query().Get("id"))
	if it == nil {
		http.NotFound(w, r)
		return
	}
	path := it.Path
	if r.URL.Query().Get("wav") == "1" || !nativePlayable[it.Codec] {
		p, err := a.cachedDecode(it, "play", []string{"-c:a", "pcm_s16le"})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		path = p
	}
	serveFile(w, r, path)
}

// /api/pcm?id=…&sr=44100&ch=2 — float32 WAV for the editor (Web Audio).
func (a *App) handlePCM(w http.ResponseWriter, r *http.Request) {
	it := a.lib.Get(r.URL.Query().Get("id"))
	if it == nil {
		http.NotFound(w, r)
		return
	}
	sr, _ := strconv.Atoi(r.URL.Query().Get("sr"))
	ch, _ := strconv.Atoi(r.URL.Query().Get("ch"))
	args := []string{"-c:a", "pcm_f32le"}
	key := "pcm"
	if sr > 0 && sr != it.SampleRate {
		args = append(args, "-ar", strconv.Itoa(sr))
		key += "-" + strconv.Itoa(sr)
	}
	if ch > 0 && ch != it.Channels {
		args = append(args, "-ac", strconv.Itoa(ch))
		key += "-c" + strconv.Itoa(ch)
	}
	if it.Codec == "pcm_f32le" && key == "pcm" && strings.HasSuffix(it.Path, ".wav") {
		serveFile(w, r, it.Path)
		return
	}
	p, err := a.cachedDecode(it, key, args)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	serveFile(w, r, p)
}

var decodeLocks sync.Map

func (a *App) cachedDecode(it *Item, key string, codecArgs []string) (string, error) {
	out := filepath.Join(a.workDir, it.ID+"-"+key+".wav")
	lk, _ := decodeLocks.LoadOrStore(out, &sync.Mutex{})
	mu := lk.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if fileExists(out) {
		return out, nil
	}
	args := append([]string{"-v", "error", "-y", "-i", it.Path, "-vn", "-map", "0:a:0"}, codecArgs...)
	args = append(args, "-f", "wav", out+".part")
	if b, err := exec.Command(tool("ffmpeg"), args...).CombinedOutput(); err != nil {
		os.Remove(out + ".part")
		return "", fmt.Errorf("디코딩 실패: %s", strings.TrimSpace(string(b)))
	}
	return out, os.Rename(out+".part", out)
}

func serveFile(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	ct := map[string]string{".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4",
		".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp4": "audio/mp4"}[strings.ToLower(filepath.Ext(path))]
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, filepath.Base(path), st.ModTime(), f)
}

func sortedKeys(m map[string]string) []string {
	k := make([]string, 0, len(m))
	for x := range m {
		k = append(k, x)
	}
	sort.Strings(k)
	return k
}
