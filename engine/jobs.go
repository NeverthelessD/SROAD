package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var errCanceled = errors.New("canceled")

type Job struct {
	ID       string         `json:"id"`
	Kind     string         `json:"kind"` // vocal | track | pitch | tempo | export | save
	ItemID   string         `json:"itemId"`
	ItemName string         `json:"itemName"`
	Title    string         `json:"title"` // e.g. "보컬 추출"
	Detail   string         `json:"detail"`
	Params   map[string]any `json:"params"`
	Export   ExportSettings `json:"export"`
	AutoSave bool           `json:"autoSave"`
	Batch    string         `json:"batch,omitempty"`

	State    string   `json:"state"` // queued | running | done | error | canceled
	Progress float64  `json:"progress"`
	Stage    string   `json:"stage"`
	Device   string   `json:"device,omitempty"`
	Created  int64    `json:"created"`
	Started  int64    `json:"started,omitempty"`
	Finished int64    `json:"finished,omitempty"`
	Results  []string `json:"results"`
	Saved    []string `json:"saved"`
	Error    string   `json:"error,omitempty"`

	cancel context.CancelFunc
	upload string // for export jobs: uploaded wav
	label  string
}

type JobManager struct {
	mu     sync.Mutex
	jobs   []*Job
	wake   chan struct{}
	wakeQ  chan struct{}
	active int
}

func NewJobManager() *JobManager {
	return &JobManager{wake: make(chan struct{}, 1), wakeQ: make(chan struct{}, 1)}
}

func isQuick(kind string) bool { return kind == "export" || kind == "save" }

func (m *JobManager) Add(j *Job) {
	m.mu.Lock()
	j.State = "queued"
	j.Created = time.Now().UnixMilli()
	j.Results, j.Saved = []string{}, []string{}
	m.jobs = append(m.jobs, j)
	m.mu.Unlock()
	if isQuick(j.Kind) {
		select {
		case m.wakeQ <- struct{}{}:
		default:
		}
	} else {
		select {
		case m.wake <- struct{}{}:
		default:
		}
	}
}

func (m *JobManager) Snapshot() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Job, 0, len(m.jobs))
	for _, j := range m.jobs {
		c := *j
		c.Results = append([]string{}, j.Results...)
		c.Saved = append([]string{}, j.Saved...)
		out = append(out, c)
	}
	return out
}

func (m *JobManager) Busy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if j.State == "queued" || j.State == "running" {
			return true
		}
	}
	return false
}

func (m *JobManager) AIBusy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if !isQuick(j.Kind) && (j.State == "queued" || j.State == "running") {
			return true
		}
	}
	return false
}

func (m *JobManager) next(quick bool) *Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if j.State == "queued" && isQuick(j.Kind) == quick {
			ctx, cancel := context.WithCancel(context.Background())
			j.cancel = cancel
			j.State = "running"
			j.Started = time.Now().UnixMilli()
			_ = ctx
			jobCtx.Store(j.ID, ctx)
			return j
		}
	}
	return nil
}

var jobCtx sync.Map

func (m *JobManager) run() {
	for {
		j := m.next(false)
		if j == nil {
			<-m.wake
			continue
		}
		m.exec(j)
	}
}

func (m *JobManager) runQuick() {
	for {
		j := m.next(true)
		if j == nil {
			<-m.wakeQ
			continue
		}
		m.exec(j)
	}
}

func (m *JobManager) exec(j *Job) {
	c, _ := jobCtx.Load(j.ID)
	ctx := c.(context.Context)
	defer jobCtx.Delete(j.ID)
	err := runJob(ctx, j)
	m.mu.Lock()
	defer m.mu.Unlock()
	j.Finished = time.Now().UnixMilli()
	switch {
	case errors.Is(err, errCanceled) || ctx.Err() != nil:
		j.State, j.Stage = "canceled", "취소됨"
	case err != nil:
		j.State, j.Error, j.Stage = "error", err.Error(), "실패"
		log.Printf("job %s (%s) failed: %v", j.ID, j.Kind, err)
	default:
		j.State, j.Progress, j.Stage = "done", 1, "완료"
		if app.Settings().RevealAfter && len(j.Saved) > 0 {
			reveal(j.Saved)
		}
	}
	if j.cancel != nil {
		j.cancel()
	}
	if j.upload != "" {
		os.Remove(j.upload)
	}
}

func (m *JobManager) Cancel(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if j.ID == id || (id != "" && j.Batch == id) {
			if j.State == "queued" {
				j.State, j.Stage = "canceled", "취소됨"
			} else if j.State == "running" && j.cancel != nil {
				j.cancel()
			}
		}
	}
}

func (m *JobManager) CancelAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if j.State == "queued" {
			j.State, j.Stage = "canceled", "취소됨"
		} else if j.State == "running" && j.cancel != nil {
			j.cancel()
		}
	}
}

func (m *JobManager) ClearFinished() {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keep []*Job
	for _, j := range m.jobs {
		if j.State == "queued" || j.State == "running" {
			keep = append(keep, j)
		}
	}
	m.jobs = keep
}

func setProgress(j *Job, p float64, stage string) {
	app.jobs.mu.Lock()
	if p > j.Progress || p == 0 {
		j.Progress = math.Min(1, p)
	}
	if stage != "" {
		j.Stage = stage
	}
	app.jobs.mu.Unlock()
}

// ---------------------------------------------------------------- HTTP

type jobRequest struct {
	Kind   string         `json:"kind"`
	IDs    []string       `json:"ids"`
	Params map[string]any `json:"params"`
	Export ExportSettings `json:"export"`
	Batch  bool           `json:"batch"`
}

var modeTitle = map[string]string{"vocal": "보컬 추출", "track": "악기 분리", "pitch": "키 변경", "tempo": "템포 변경"}

func (a *App) handleJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, a.jobs.Snapshot())
		return
	}
	var in jobRequest
	if readJSON(r, &in) != nil {
		jsonError(w, 400, "bad request")
		return
	}
	if _, ok := modeTitle[in.Kind]; !ok {
		jsonError(w, 400, "알 수 없는 작업이에요")
		return
	}
	if !a.setup.Ready() {
		jsonError(w, 503, "AI 엔진 설치가 끝난 뒤에 사용할 수 있어요")
		return
	}
	in.Export.normalize()
	batch := ""
	if in.Batch && len(in.IDs) > 1 {
		batch = randID(6)
	}
	auto := a.Settings().AutoSave
	var ids []string
	for _, id := range in.IDs {
		it := a.lib.Get(id)
		if it == nil {
			continue
		}
		j := &Job{ID: randID(8), Kind: in.Kind, ItemID: id, ItemName: displayName(it), Title: modeTitle[in.Kind],
			Params: in.Params, Export: in.Export, AutoSave: auto, Batch: batch, Stage: "대기 중"}
		j.Detail = describeParams(in.Kind, in.Params)
		a.jobs.Add(j)
		ids = append(ids, j.ID)
	}
	if len(ids) == 0 {
		jsonError(w, 404, "처리할 곡이 없어요")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "jobs": ids, "batch": batch})
}

func (a *App) handleJobCancel(w http.ResponseWriter, r *http.Request) {
	a.jobs.Cancel(r.URL.Query().Get("id"))
	writeJSON(w, map[string]any{"ok": true})
}

// /api/export?id=…&label=편집본&format=&quality=&folder=   body: WAV from the editor
func (a *App) handleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		jsonError(w, 405, "POST only")
		return
	}
	q := r.URL.Query()
	src := a.lib.Get(q.Get("id"))
	if src == nil {
		jsonError(w, 404, "원본 곡을 찾을 수 없어요")
		return
	}
	es := ExportSettings{Format: q.Get("format"), Quality: q.Get("quality"), Folder: q.Get("folder")}
	es.normalize()
	path := filepath.Join(a.workDir, "upload-"+randID(6)+".wav")
	f, err := os.Create(path)
	if err != nil {
		jsonError(w, 500, "임시 파일을 만들 수 없어요")
		return
	}
	_, err = io.Copy(f, r.Body)
	f.Close()
	if err != nil {
		os.Remove(path)
		jsonError(w, 500, "편집본을 받지 못했어요")
		return
	}
	label := q.Get("label")
	if label == "" {
		label = "편집본"
	}
	j := &Job{ID: randID(8), Kind: "export", ItemID: src.ID, ItemName: displayName(src), Title: "편집본 내보내기",
		Detail: es.Describe(), Export: es, AutoSave: true, Stage: "대기 중", upload: path, label: label}
	a.jobs.Add(j)
	writeJSON(w, map[string]any{"ok": true, "job": j.ID})
}

// /api/save-item {id, export} — save (again) a result with the current export settings.
func (a *App) handleSaveItem(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID     string         `json:"id"`
		Export ExportSettings `json:"export"`
	}
	if readJSON(r, &in) != nil {
		jsonError(w, 400, "bad request")
		return
	}
	it := a.lib.Get(in.ID)
	if it == nil {
		jsonError(w, 404, "곡을 찾을 수 없어요")
		return
	}
	in.Export.normalize()
	j := &Job{ID: randID(8), Kind: "save", ItemID: it.ID, ItemName: displayName(it), Title: "저장",
		Detail: in.Export.Describe(), Export: in.Export, AutoSave: true, Stage: "대기 중"}
	a.jobs.Add(j)
	writeJSON(w, map[string]any{"ok": true, "job": j.ID})
}

func displayName(it *Item) string {
	if it.Kind == "result" {
		return it.Base
	}
	return it.Name
}

func num(p map[string]any, k string, def float64) float64 {
	switch v := p[k].(type) {
	case float64:
		return v
	case string:
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func boolp(p map[string]any, k string, def bool) bool {
	if v, ok := p[k].(bool); ok {
		return v
	}
	return def
}

func strs(p map[string]any, k string) []string {
	var out []string
	if arr, ok := p[k].([]any); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

func signed(n float64) string {
	if n > 0 {
		return "+" + strconv.FormatFloat(n, 'f', -1, 64)
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func describeParams(kind string, p map[string]any) string {
	switch kind {
	case "vocal":
		var parts []string
		if boolp(p, "instrumental", true) {
			parts = append(parts, "MR")
		}
		if boolp(p, "vocals", true) {
			parts = append(parts, "보컬")
		}
		q := "빠름"
		if p["model"] == "htdemucs_ft" {
			q = "고품질"
		}
		return strings.Join(parts, " + ") + " · " + q
	case "track":
		if p["model"] == "htdemucs_6s" {
			return "6트랙"
		}
		return "4트랙"
	case "pitch":
		return "키 " + signed(num(p, "semitones", 0))
	case "tempo":
		return fmt.Sprintf("템포 %.0f%%", num(p, "rate", 1)*100)
	}
	return ""
}

// ---------------------------------------------------------------- job execution

var stemInfo = map[string][2]string{ // name → {Korean label, English file suffix}
	"vocals": {"보컬", "Vocals"}, "drums": {"드럼", "Drums"}, "bass": {"베이스", "Bass"},
	"other": {"기타 악기", "Other"}, "guitar": {"기타", "Guitar"}, "piano": {"피아노", "Piano"},
}

func runJob(ctx context.Context, j *Job) error {
	src := app.lib.Get(j.ItemID)
	if src == nil {
		return errors.New("원본 곡이 목록에서 사라졌어요")
	}
	dir := filepath.Join(app.workDir, "job-"+j.ID)
	os.MkdirAll(dir, 0o755)
	defer func() {
		// 결과 wav는 라이브러리 항목으로 옮겨 두었으니 나머지 임시 파일만 지웁니다
		os.RemoveAll(dir)
	}()

	switch j.Kind {
	case "save":
		setProgress(j, 0.1, "파일로 저장하는 중")
		p, err := saveItem(ctx, src, j.Export, "")
		if err != nil {
			return err
		}
		app.lib.Update(src.ID, func(it *Item) { it.SavedPath = p })
		j.Saved = append(j.Saved, p)
		return nil
	case "export":
		return runExport(ctx, j, src)
	}

	// AI 작업 공통: 모델 준비 → 디코딩 → worker → 결과 등록 → 자동 저장
	model := ""
	switch j.Kind {
	case "vocal":
		model = "htdemucs"
		if j.Params["model"] == "htdemucs_ft" {
			model = "htdemucs_ft"
		}
	case "track":
		model = "htdemucs"
		if j.Params["model"] == "htdemucs_6s" {
			model = "htdemucs_6s"
		}
	}
	if model != "" {
		if err := app.setup.EnsureModel(ctx, model, func(p float64) {
			setProgress(j, 0, fmt.Sprintf("AI 모델 받는 중 %d%%", int(p*100)))
		}); err != nil {
			return err
		}
	}

	setProgress(j, 0.01, "음원 준비 중")
	in := filepath.Join(dir, "in.wav")
	dec := []string{"-v", "error", "-y", "-i", src.Path, "-vn", "-map", "0:a:0", "-c:a", "pcm_f32le"}
	if model != "" {
		dec = append(dec, "-ac", "2", "-ar", "44100")
	}
	dec = append(dec, in)
	if out, err := exec.CommandContext(ctx, tool("ffmpeg"), dec...).CombinedOutput(); err != nil {
		if ctx.Err() != nil {
			return errCanceled
		}
		return fmt.Errorf("음원을 읽지 못했어요: %s", lastLine(string(out)))
	}
	setProgress(j, 0.04, "")

	task := map[string]any{}
	switch j.Kind {
	case "vocal":
		task = map[string]any{"task": "separate", "mode": "vocal", "model": model, "input": in, "outdir": filepath.Join(dir, "out"),
			"vocals": boolp(j.Params, "vocals", true), "instrumental": boolp(j.Params, "instrumental", true)}
		if !task["vocals"].(bool) && !task["instrumental"].(bool) {
			task["instrumental"] = true
		}
	case "track":
		task = map[string]any{"task": "separate", "mode": "track", "model": model, "input": in, "outdir": filepath.Join(dir, "out"),
			"stems": strs(j.Params, "stems"), "mix": strs(j.Params, "mix")}
	case "pitch":
		task = map[string]any{"task": "stretch", "input": in, "output": filepath.Join(dir, "out.wav"),
			"semitones": num(j.Params, "semitones", 0), "rate": 1.0, "formants": boolp(j.Params, "formants", true), "label": "키를 바꾸는 중"}
	case "tempo":
		task = map[string]any{"task": "stretch", "input": in, "output": filepath.Join(dir, "out.wav"),
			"semitones": 0.0, "rate": num(j.Params, "rate", 1), "keep_pitch": boolp(j.Params, "keepPitch", true), "label": "템포를 바꾸는 중"}
	}
	outputs, err := runWorker(ctx, j, task, dir, 0.05, 0.88)
	if err != nil {
		return err
	}

	// 결과 등록
	type outSpec struct{ key, label, file, stem string }
	var specs []outSpec
	subdir := ""
	switch j.Kind {
	case "vocal":
		if p := outputs["instrumental"]; p != "" {
			specs = append(specs, outSpec{"instrumental", "MR", src.Base + " (MR)", "instrumental"})
		}
		if p := outputs["vocals"]; p != "" {
			specs = append(specs, outSpec{"vocals", "보컬", src.Base + " (Vocal)", "vocals"})
		}
	case "track":
		subdir = src.Base + " (ROAD Track)"
		for _, name := range []string{"vocals", "drums", "bass", "guitar", "piano", "other"} {
			if outputs[name] != "" {
				info := stemInfo[name]
				specs = append(specs, outSpec{name, info[0], src.Base + " - " + info[1], name})
			}
		}
		if outputs["mix"] != "" {
			var names []string
			for _, s := range strs(j.Params, "mix") {
				names = append(names, stemInfo[s][1])
			}
			specs = append(specs, outSpec{"mix", "믹스", src.Base + " - Mix (" + strings.Join(names, "+") + ")", "mix"})
		}
	case "pitch":
		s := signed(num(j.Params, "semitones", 0))
		specs = append(specs, outSpec{"output", "키 " + s, src.Base + " (Key " + s + ")", ""})
	case "tempo":
		pct := fmt.Sprintf("%.0f%%", num(j.Params, "rate", 1)*100)
		name := " (Tempo " + pct + ")"
		if !boolp(j.Params, "keepPitch", true) {
			name = " (Speed " + pct + ")"
		}
		specs = append(specs, outSpec{"output", "템포 " + pct, src.Base + name, ""})
	}
	if len(specs) == 0 {
		return errors.New("결과 파일이 만들어지지 않았어요")
	}

	setProgress(j, 0.9, "결과 정리 중")
	var made []*Item
	for _, s := range specs {
		id := randID(8)
		dst := filepath.Join(app.workDir, id+"-res.wav")
		if err := os.Rename(outputs[s.key], dst); err != nil {
			return err
		}
		it, err := probe(dst)
		if err != nil {
			return err
		}
		it.ID, it.Kind, it.ParentID, it.RootID = id, "result", src.ID, src.RootID
		it.Mode, it.Label, it.Stem = j.Kind, s.label, s.stem
		it.Base = sanitizeName(s.file)
		it.Name = it.Base + ".wav"
		it.Ext = "wav"
		it.Title, it.Artist, it.Album = src.Title, src.Artist, src.Album
		it.MetaPath, it.HasArt = src.MetaPath, src.HasArt
		if src.Bits > it.Bits {
			it.Bits = src.Bits
		} else if it.Bits == 32 || it.Bits == 0 {
			it.Bits = max(16, src.Bits)
		}
		it.Size = fileSize(dst)
		it.Path = dst
		it.Created = time.Now().UnixMilli()
		it.Peaks = peaks(dst, 240)
		app.lib.Add(it)
		made = append(made, it)
		j.Results = append(j.Results, id)
	}

	if j.AutoSave {
		for i, it := range made {
			setProgress(j, 0.9+0.1*float64(i)/float64(len(made)), "파일로 저장하는 중")
			p, err := saveItem(ctx, it, j.Export, subdir)
			if err != nil {
				return err
			}
			app.lib.Update(it.ID, func(x *Item) { x.SavedPath = p })
			j.Saved = append(j.Saved, p)
		}
	}
	return nil
}

func runExport(ctx context.Context, j *Job, src *Item) error {
	setProgress(j, 0.1, "편집본 정리 중")
	id := randID(8)
	dst := filepath.Join(app.workDir, id+"-res.wav")
	if err := os.Rename(j.upload, dst); err != nil {
		return err
	}
	j.upload = ""
	it, err := probe(dst)
	if err != nil {
		return err
	}
	it.ID, it.Kind, it.ParentID, it.RootID = id, "result", src.ID, src.RootID
	it.Mode, it.Label = "edit", j.label
	it.Base = sanitizeName(src.Base + " (Edit)")
	it.Name, it.Ext = it.Base+".wav", "wav"
	it.Title, it.Artist, it.Album = src.Title, src.Artist, src.Album
	it.MetaPath, it.HasArt = src.MetaPath, src.HasArt
	it.Bits = max(16, src.Bits)
	if it.Bits == 32 {
		it.Bits = 24
	}
	it.Path, it.Size, it.Created = dst, fileSize(dst), time.Now().UnixMilli()
	it.Peaks = peaks(dst, 240)
	app.lib.Add(it)
	j.Results = append(j.Results, id)
	setProgress(j, 0.4, "파일로 저장하는 중")
	p, err := saveItem(ctx, it, j.Export, "")
	if err != nil {
		return err
	}
	app.lib.Update(it.ID, func(x *Item) { x.SavedPath = p })
	j.Saved = append(j.Saved, p)
	return nil
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

// runWorker runs worker.py and maps its 0..1 progress into [from, to].
func runWorker(ctx context.Context, j *Job, task map[string]any, dir string, from, to float64) (map[string]string, error) {
	jf := filepath.Join(dir, "task.json")
	b, _ := json.Marshal(task)
	if err := os.WriteFile(jf, b, 0o644); err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, app.setup.Python(), filepath.Join(app.support, "worker.py"), jf)
	cmd.Env = app.setup.WorkerEnv()
	setProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 64 << 10}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("AI 엔진을 시작하지 못했어요: %v", err)
	}
	stop := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			killProcessGroup(cmd)
		case <-stop:
		}
	}()
	outputs := map[string]string{}
	var werr string
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var msg map[string]any
		if json.Unmarshal(sc.Bytes(), &msg) != nil {
			continue
		}
		switch msg["type"] {
		case "progress":
			v, _ := msg["value"].(float64)
			st, _ := msg["stage"].(string)
			setProgress(j, from+(to-from)*v, st)
		case "info":
			if d, ok := msg["device"].(string); ok {
				app.jobs.mu.Lock()
				j.Device = d
				app.jobs.mu.Unlock()
			}
		case "result":
			if o, ok := msg["outputs"].(map[string]any); ok {
				for k, v := range o {
					if s, ok := v.(string); ok {
						outputs[k] = s
					}
				}
			}
		case "error":
			werr, _ = msg["message"].(string)
		}
	}
	err = cmd.Wait()
	close(stop)
	if ctx.Err() != nil {
		return nil, errCanceled
	}
	if werr != "" {
		log.Printf("worker error: %s\n%s", werr, stderr.String())
		return nil, friendlyWorkerError(werr)
	}
	if err != nil {
		log.Printf("worker failed: %v\n%s", err, stderr.String())
		return nil, fmt.Errorf("AI 처리 중 문제가 생겼어요 (%v)", err)
	}
	return outputs, nil
}

func friendlyWorkerError(msg string) error {
	l := strings.ToLower(msg)
	switch {
	case strings.Contains(l, "out of memory") || strings.Contains(l, "memory"):
		return errors.New("메모리가 부족해요. 다른 앱을 닫거나 더 짧은 곡으로 시도해 주세요.")
	case strings.Contains(l, "no module"):
		return errors.New("AI 엔진 구성요소가 빠져 있어요. 설정 → AI 엔진 다시 설치를 눌러 주세요.")
	}
	return errors.New("AI 처리 실패: " + msg)
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	q := p
	if len(q) > l.n {
		q = q[:l.n]
	}
	l.n -= len(q)
	l.w.Write(q)
	return len(p), nil
}
