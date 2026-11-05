// RYACHA, inside Premiere. ExtendScript is ES3: no let, no arrow functions, no JSON object.
// Every pubs_ function returns a JSON string, with { error } on failure.
// It only ADDS to the open project (bins, imported rushes, sequences) and never deletes or replaces
// anything that was already there: a sequence whose name already exists in its bin is left alone.

var PUBS_TICKS = 254016000000;
var pubsJob = null;
var pubsItems = {}; // media id -> ProjectItem
var pubsSeqs = {}; // part key -> Sequence

function pubsJson(value) {
  if (value === null || value === undefined) return 'null';
  var type = typeof value;
  if (type === 'number') return isFinite(value) ? String(value) : 'null';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string') return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  var parts = [];
  if (value instanceof Array) {
    for (var i = 0; i < value.length; i++) parts.push(pubsJson(value[i]));
    return '[' + parts.join(',') + ']';
  }
  for (var key in value) if (value.hasOwnProperty(key)) parts.push(pubsJson(key) + ':' + pubsJson(value[key]));
  return '{' + parts.join(',') + '}';
}
function pubsFail(e) { return pubsJson({ error: String(e && e.message ? e.message : e) }); }

function pubsRead(file) {
  var f = new File(file);
  f.encoding = 'UTF-8';
  if (!f.open('r')) throw new Error('Fichier de construction illisible.');
  var text = f.read();
  f.close();
  return eval('(' + text + ')');
}

function pubsChild(bin, name, type) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var c = bin.children[i];
    if (c.name === name && (type === undefined || c.type === type)) return c;
  }
  return null;
}

// "2.ADS" / "S7" / "VARIANTE 1": found or created from the project root
function pubsBin(path) {
  var bin = app.project.rootItem;
  for (var i = 0; i < path.length; i++) bin = pubsChild(bin, path[i], ProjectItemType.BIN) || bin.createBin(path[i]);
  return bin;
}

// Same path, found only: looking something up never creates bins.
function pubsFindBin(path) {
  var bin = app.project.rootItem;
  for (var i = 0; i < path.length && bin; i++) bin = pubsChild(bin, path[i], ProjectItemType.BIN);
  return bin;
}

// One of the job's sequences, where the build put it (null if it isn't there).
function pubsJobSequence(s) {
  var bin = pubsFindBin(s.bin);
  return bin ? pubsFindSequence(s.name, bin) : null;
}

function pubsWalk(bin, visit) {
  for (var i = 0; i < bin.children.numItems; i++) {
    var item = bin.children[i];
    visit(item);
    if (item.type === ProjectItemType.BIN) pubsWalk(item, visit);
  }
}

function pubsByPath(file) {
  var found = null;
  var want = new File(file).fsName;
  pubsWalk(app.project.rootItem, function (item) {
    if (found || item.type !== ProjectItemType.CLIP) return;
    try { if (new File(item.getMediaPath()).fsName === want) found = item; } catch (e) {}
  });
  return found;
}

function pubs_info() {
  try {
    if (!app.project) return pubsFail('Ouvre un projet Premiere.');
    return pubsJson({ project: app.project.name, path: app.project.path, sequences: app.project.sequences.numSequences });
  } catch (e) { return pubsFail(e); }
}

// Reads the job, imports the rushes once (reused if the project already has them).
function pubs_begin(file) {
  try {
    pubsJob = pubsRead(file);
    pubsItems = {};
    pubsSeqs = {};
    var bin = null;
    for (var i = 0; i < pubsJob.media.length; i++) {
      var m = pubsJob.media[i];
      var item = pubsByPath(m.path);
      if (!item) {
        bin = bin || pubsBin(pubsJob.importBin);
        app.project.importFiles([m.path], true, bin, false);
        item = pubsByPath(m.path);
      }
      if (!item) return pubsFail('Import impossible : ' + m.path);
      pubsItems[m.id] = item;
    }
    return pubsJson({ ok: true, sequences: pubsJob.sequences.length });
  } catch (e) { return pubsFail(e); }
}

function pubsFindSequence(name, bin) {
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    var s = app.project.sequences[i];
    if (s.name === name && s.projectItem && pubsChild(bin, name)) return s;
  }
  return null;
}

function pubsClear(seq) {
  var groups = [seq.videoTracks, seq.audioTracks];
  for (var g = 0; g < groups.length; g++) {
    for (var t = 0; t < groups[g].numTracks; t++) {
      var clips = groups[g][t].clips;
      for (var c = clips.numItems - 1; c >= 0; c--) clips[c].remove(false, false);
    }
  }
}

// Every sequence RYACHA makes runs at exactly 30 fps.
function pubsSet30(seq) {
  var st = seq.getSettings();
  var t = new Time();
  t.ticks = String(PUBS_TICKS / 30);
  st.videoFrameRate = t;
  seq.setSettings(st);
}

function pubsTime(seconds) {
  var t = new Time();
  t.seconds = seconds;
  return t;
}

// One sequence of the job: rush pieces back to back, part sequences (corps, transis) nested whole.
// Times are snapped to the sequence's frames so pieces never overlap or leave a one-frame gap.
function pubs_sequence(index) {
  try {
    var s = pubsJob.sequences[index];
    var bin = pubsBin(s.bin);
    var existing = pubsFindSequence(s.name, bin);
    if (existing) { pubsSeqs[s.key] = existing; return pubsJson({ ok: true, skipped: true, name: s.name }); }
    var first = pubsItems[pubsJob.media[0].id];
    for (var k = 0; k < s.clips.length; k++) if (s.clips[k].media) { first = pubsItems[s.clips[k].media]; break; }
    var seq = app.project.createNewSequenceFromClips(s.name, [first], bin);
    if (!seq) return pubsFail('Séquence impossible à créer : ' + s.name);
    pubsClear(seq);
    pubsSet30(seq); // phone and teleprompter rushes run at odd rates (29.99…): deliverables are 30 fps
    var fps = PUBS_TICKS / parseFloat(seq.timebase);
    var frame = 0; // timeline position, in frames
    var track = seq.videoTracks[0];
    for (var i = 0; i < s.clips.length; i++) {
      var c = s.clips[i];
      var item, frames;
      if (c.seq) {
        var part = pubsSeqs[c.seq];
        if (!part) return pubsFail('Séquence manquante pour ' + c.seq);
        item = part.projectItem;
        item.clearInPoint();
        item.clearOutPoint();
        frames = Math.round((parseFloat(part.end) / PUBS_TICKS) * fps);
      } else {
        item = pubsItems[c.media];
        var a = Math.round(c['in'] * fps), b = Math.round(c.out * fps);
        if (b <= a) continue;
        item.setInPoint(a / fps, 4);
        item.setOutPoint(b / fps, 4);
        frames = b - a;
      }
      track.overwriteClip(item, pubsTime(frame / fps));
      frame += frames;
    }
    pubsSeqs[s.key] = seq;
    return pubsJson({ ok: true, name: s.name, seconds: frame / fps });
  } catch (e) { return pubsFail(e); }
}

// ---------- captions, step 2: made from the editor's final cut of each part ----------
// The part's audio, rendered by Premiere as it is now (after the editor's small cuts).
function pubs_renderAudio(index, out, preset) {
  try {
    var s = pubsJob.sequences[index];
    var seq = pubsJobSequence(s);
    if (!seq) return pubsFail('Séquence introuvable : ' + s.name);
    var f = new File(out);
    if (f.exists) f.remove(); // our own temporary file from an earlier run
    seq.exportAsMediaDirect(f.fsName, new File(preset).fsName, app.encoder.ENCODE_ENTIRE);
    if (!new File(out).exists) return pubsFail('Premiere n’a pas rendu le son de ' + s.name);
    return pubsJson({ ok: true });
  } catch (e) { return pubsFail(e); }
}

// The SRT RYACHA made from that audio, as a new caption track of the part (it shows in every ad nesting it).
function pubs_addCaptions(index, file) {
  try {
    var s = pubsJob.sequences[index];
    var seq = pubsJobSequence(s);
    if (!seq) return pubsFail('Séquence introuvable : ' + s.name);
    var bin = pubsBin(pubsJob.importBin.concat(['SRT']));
    app.project.importFiles([new File(file).fsName], true, bin, false);
    var item = pubsByPath(file);
    if (!item) return pubsFail('Import du SRT impossible : ' + file);
    seq.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE);
    return pubsJson({ ok: true, name: s.name });
  } catch (e) { return pubsFail(e); }
}

// The editor's caption style (.prtextstyle) into the project, once: it then shows in Premiere's Track Style list.
// styleName = the name written inside the file: Premiere gives it to the imported style (not the file's name)
function pubs_importStyle(file, styleName) {
  try {
    var name = styleName || decodeURI(new File(file).name).replace(/\.prtextstyle$/i, '');
    var found = null;
    pubsWalk(app.project.rootItem, function (item) { if (!found && item.name === name && item.type !== ProjectItemType.BIN) found = item; });
    if (found) return pubsJson({ ok: true, name: name, existed: true });
    app.project.importFiles([new File(file).fsName], true, pubsBin(pubsJob.importBin.concat(['SRT'])), false);
    return pubsJson({ ok: true, name: name });
  } catch (e) { return pubsFail(e); }
}

// The caption styles already in the project (Premiere lists them as items of type 5), by name.
function pubs_listStyles() {
  try {
    var names = [], seen = {};
    pubsWalk(app.project.rootItem, function (item) {
      if (item.type === 5 && !seen[item.name]) { seen[item.name] = true; names.push(item.name); }
    });
    return pubsJson({ names: names });
  } catch (e) { return pubsFail(e); }
}

// The caption style can only be set in the saved project file: the panel saves and closes the project,
// links the caption tracks to the style, then reopens it.
function pubs_saveAndClose() {
  try {
    var p = app.project;
    if (!p || !p.path) return pubsFail('Enregistre d’abord le projet.');
    var path = p.path;
    p.save();
    var ok = p.closeDocument(true, false);
    return pubsJson({ ok: !!ok, path: path });
  } catch (e) { return pubsFail(e); }
}

function pubs_reopen(path) {
  try {
    var ok = app.openDocument(new File(path).fsName, true, true, true, true);
    return pubsJson({ ok: !!ok });
  } catch (e) { return pubsFail(e); }
}

// ---------- zooms (the zoomi lia hna la7malidik way: one adjustment layer per shot, Transform scale) ----------
// Run after the editor's small cuts. Each of the job's sequences zooms on its footage track (V1): an ad
// up to its nested corps/transi, a corps or transi sequence all the way. Earlier zooms ("zoomi zoom"
// layers, from this panel or from zoomi) in that range are replaced; nothing else is touched.
var PUBS_LAYER = 'zoomi zoom';
var PUBS_TRANSFORM = 'AE.ADBE Geometry';
var PUBS_TRANSFORM_NAMES = ['Transform', 'Transformer', 'Transformieren', 'Transformar', 'Trasforma'];
var PUBS_MARGIN = 0.05;
var pubsLayerItem = null;

// The job's sequences as they are now in the project, with the cuts the zooms follow.
function pubs_zoomInfo(file) {
  try {
    pubsJob = pubsRead(file);
    var out = [];
    for (var i = 0; i < pubsJob.sequences.length; i++) {
      var s = pubsJob.sequences[i];
      var seq = pubsJobSequence(s);
      if (!seq) { out.push({ index: i, name: s.name, kind: s.kind, missing: true }); continue; }
      var st = seq.getSettings();
      var fps = PUBS_TICKS / parseFloat(seq.timebase);
      var end = parseFloat(seq.end) / PUBS_TICKS;
      var tracks = [];
      for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var clips = [];
        for (var c = 0; c < seq.videoTracks[t].clips.numItems; c++) {
          var clip = seq.videoTracks[t].clips[c];
          clips.push({ name: clip.name, start: clip.start.seconds, end: clip.end.seconds });
        }
        tracks.push(clips);
      }
      out.push({ index: i, name: s.name, kind: s.kind || (String(s.key).indexOf('ad:') === 0 ? 'ad' : 'part'), width: st.videoFrameWidth, height: st.videoFrameHeight, fps: fps, end: end, tracks: tracks, clips: tracks[0] || [] });
    }
    return pubsJson({ sequences: out });
  } catch (e) { return pubsFail(e); }
}

function pubsFindLayer(name) {
  var found = null;
  pubsWalk(app.project.rootItem, function (item) {
    if (found || item.type === ProjectItemType.BIN || item.name !== name) return;
    try { if (item.isAdjustmentLayer()) found = item; } catch (e) {}
  });
  return found;
}

// Scripts can't create an adjustment layer: it comes from a template project sized to the sequence.
function pubs_zoomBegin(template, name) {
  try {
    pubsLayerItem = pubsFindLayer(name);
    if (pubsLayerItem) return pubsJson({ ok: true });
    app.project.importFiles([new File(template).fsName], true, pubsBin(pubsJob.importBin), false);
    for (var i = app.project.sequences.numSequences - 1; i >= 0; i--) {
      if (app.project.sequences[i].name === 'zoomi template') app.project.deleteSequence(app.project.sequences[i]); // came with the template
    }
    pubsLayerItem = pubsFindLayer(name);
    if (!pubsLayerItem) return pubsFail('Premiere garde une ancienne copie du calque de zoom sous un autre nom. Renomme-la « ' + name + ' » ou supprime-la.');
    return pubsJson({ ok: true });
  } catch (e) { return pubsFail(e); }
}

function pubsClipAt(track, seconds) {
  for (var i = 0; i < track.clips.numItems; i++) if (Math.abs(track.clips[i].start.seconds - seconds) < 0.01) return track.clips[i];
  return null;
}

function pubsFree(track, zooms) {
  for (var c = 0; c < track.clips.numItems; c++) {
    var clip = track.clips[c];
    for (var z = 0; z < zooms.length; z++) if (zooms[z].start < clip.end.seconds && zooms[z].end + PUBS_MARGIN > clip.start.seconds) return false;
  }
  return true;
}

function pubsTransform() {
  for (var i = 0; i < PUBS_TRANSFORM_NAMES.length; i++) {
    var effect = qe.project.getVideoEffectByName(PUBS_TRANSFORM_NAMES[i]);
    if (effect) return effect;
  }
  throw new Error('Effet Transformer introuvable.');
}

// QE lists the gaps between clips as items too, so its indexes differ from track.clips.
function pubsQeItemAt(qeTrack, seconds) {
  for (var i = 0; i < qeTrack.numItems; i++) {
    var item = qeTrack.getItemAt(i);
    if (item.type !== 'Empty' && Math.abs(item.start.secs - seconds) < 0.01) return item;
  }
  throw new Error('Le calque de zoom ne s’est pas posé.');
}

// zooms = [{ start, end, scale }]; anchor = { x, y } in 0–1 of the frame (the face).
function pubs_zoom(index, zooms, anchor, layerTrack) {
  try {
    var s = pubsJob.sequences[index];
    var seq = pubsJobSequence(s);
    if (!seq) return pubsFail('Séquence introuvable : ' + s.name);
    var before = app.project.activeSequence;
    var wasOpen = before && before.sequenceID === seq.sequenceID;
    if (!wasOpen) app.project.openSequence(seq.sequenceID); // QE only works on the active sequence
    app.enableQE();
    var from = zooms.length ? zooms[0].start : 0, to = zooms.length ? zooms[zooms.length - 1].end : 0;
    var removed = 0;
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var clips = seq.videoTracks[t].clips;
      for (var k = clips.numItems - 1; k >= 0; k--) {
        var old = clips[k];
        if (old.name === PUBS_LAYER && old.start.seconds < to && old.end.seconds > from) { old.remove(false, false); removed++; }
      }
    }
    // right above the footage, so graphics on higher tracks stay unzoomed
    var L = layerTrack > 0 ? layerTrack : 1; // right above the highest zoomed track: higher tracks stay unzoomed
    if (seq.videoTracks.numTracks <= L || !pubsFree(seq.videoTracks[L], zooms)) qe.project.getActiveSequence().addTracks(1, L, 0);
    var track = seq.videoTracks[L];
    var qeTrack = qe.project.getActiveSequence().getVideoTrackAt(L);
    for (var i = 0; i < zooms.length; i++) {
      var z = zooms[i];
      // the layer's Out rounds to its own frame rate: put it on slightly long, then trim to the exact frame
      pubsLayerItem.setInPoint(0, 4);
      pubsLayerItem.setOutPoint(z.end - z.start + PUBS_MARGIN, 4);
      track.overwriteClip(pubsLayerItem, pubsTime(z.start));
      var placed = pubsClipAt(track, z.start);
      if (!placed) throw new Error('Le calque de zoom ne s’est pas posé.');
      placed.end = pubsTime(z.end);
      placed.name = PUBS_LAYER;
      pubsQeItemAt(qeTrack, z.start).addVideoEffect(pubsTransform());
      var fx = null;
      for (var c = placed.components.numItems - 1; c >= 0; c--) if (placed.components[c].matchName === PUBS_TRANSFORM) { fx = placed.components[c]; break; }
      if (!fx) throw new Error('L’effet Transformer ne s’est pas posé.');
      fx.properties[0].setValue([anchor.x, anchor.y], true); // anchor point
      fx.properties[1].setValue([anchor.x, anchor.y], true); // position
      fx.properties[2].setValue(true, true); // uniform scale
      fx.properties[3].setValue(z.scale, true);
    }
    if (!wasOpen) {
      try { seq.close(); } catch (e) {}
      if (before) app.project.openSequence(before.sequenceID);
    }
    return pubsJson({ ok: true, name: s.name, zooms: zooms.length, replaced: removed });
  } catch (e) { return pubsFail(e); }
}

function pubsValueAt(prop, time) { return prop.isTimeVarying() ? prop.getValueAtTime(time) : prop.getValue(); }

// Describes the picture under the playhead of the open sequence, for the panel to rebuild with ffmpeg: the top
// video clip on the zoomed tracks, skipping zoom layers, graphics and nested sequences (no file to read).
function pubs_playhead(topTrack) {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return pubsFail('Ouvre une accroche ou un corps, et place le playhead sur le visage.');
    var st = seq.getSettings();
    var playhead = seq.getPlayerPosition().seconds;
    for (var t = Math.min(topTrack, seq.videoTracks.numTracks - 1); t >= 0; t--) {
      var clips = seq.videoTracks[t].clips;
      for (var i = 0; i < clips.numItems; i++) {
        var clip = clips[i];
        if (clip.disabled || clip.name === PUBS_LAYER || playhead < clip.start.seconds || playhead >= clip.end.seconds) continue;
        var media = '';
        try { media = clip.projectItem ? clip.projectItem.getMediaPath() : ''; } catch (e) {}
        if (!media) continue;
        var offset = playhead - clip.start.seconds;
        var speed = (clip.outPoint.seconds - clip.inPoint.seconds) / (clip.end.seconds - clip.start.seconds);
        for (var k = 0; k < clip.components.numItems; k++) {
          if (clip.components[k].matchName !== 'AE.ADBE Motion') continue;
          var m = clip.components[k].properties;
          var at = pubsTime(clip.inPoint.seconds + offset);
          var position = pubsValueAt(m[0], at), anchor = pubsValueAt(m[5], at);
          var fit = false;
          try { app.enableQE(); fit = pubsQeItemAt(qe.project.getActiveSequence().getVideoTrackAt(t), clip.start.seconds).scaleToFrameSize === true; } catch (e) {}
          return pubsJson({ sequence: seq.name, width: st.videoFrameWidth, height: st.videoFrameHeight, path: media, time: clip.inPoint.seconds + offset * speed,
            scale: pubsValueAt(m[1], at), scaleWidth: pubsValueAt(m[2], at), uniform: pubsValueAt(m[3], at) === true,
            x: position[0], y: position[1], anchorX: anchor[0], anchorY: anchor[1], fit: fit });
        }
      }
    }
    return pubsFail('Pas de vidéo sous le playhead : ouvre une accroche ou un corps, et place le playhead sur le visage.');
  } catch (e) { return pubsFail(e); }
}

function pubs_zoomFinish() {
  try {
    if (pubsLayerItem) { pubsLayerItem.clearInPoint(); pubsLayerItem.clearOutPoint(); }
    pubsLayerItem = null;
    return pubsJson({ ok: true });
  } catch (e) { return pubsFail(e); }
}

// ---------- export: each ad into Media Encoder's queue, in 9x16 and in 4x5 ----------
// A 4x5 version is its own sequence, 1080x1350, nesting the 9x16 ad at a fill scale (full width, centred, top and
// bottom cut). Premiere's export ignores the "scale to fill" setting, so this is the reliable way, and the editor can
// reframe any of them by hand. An existing 4x5 sequence is never rebuilt, so a reframe is kept.
function pubsBin4x5(path) {
  var out = [];
  for (var i = 0; i < path.length; i++) out.push(path[i] === 'Export' ? 'Export 4x5' : path[i]);
  return out;
}

// What step 4 can export: for each ad, is its sequence there, and its 4x5 sequence?
function pubs_exportInfo(file) {
  try {
    pubsJob = pubsRead(file);
    var out = [];
    for (var i = 0; i < pubsJob.sequences.length; i++) {
      var s = pubsJob.sequences[i];
      var kind = s.kind || (String(s.key).indexOf('ad:') === 0 ? 'ad' : String(s.key).indexOf('review:') === 0 ? 'review' : 'part');
      if (kind !== 'ad' && kind !== 'review') continue;
      var b4 = pubsFindBin(pubsBin4x5(s.bin));
      out.push({ index: i, name: s.name, kind: kind, present: !!pubsJobSequence(s), has4x5: !!(b4 && pubsFindSequence(s.name + ' 4x5', b4)) });
    }
    return pubsJson({ sequences: out });
  } catch (e) { return pubsFail(e); }
}

function pubs_make4x5(index) {
  try {
    var s = pubsJob.sequences[index];
    var ad = pubsJobSequence(s);
    if (!ad) return pubsFail('Séquence introuvable : ' + s.name);
    var bin = pubsBin(pubsBin4x5(s.bin));
    var name = s.name + ' 4x5';
    if (pubsFindSequence(name, bin)) return pubsJson({ ok: true, existed: true, name: name });
    var src = ad.getSettings();
    var seq = app.project.createNewSequenceFromClips(name, [ad.projectItem], bin);
    if (!seq) return pubsFail('Séquence 4x5 impossible à créer : ' + name);
    var st = seq.getSettings();
    st.videoFrameWidth = 1080;
    st.videoFrameHeight = 1350;
    seq.setSettings(st);
    pubsSet30(seq);
    // fill the 4:5 frame: full width, centred (the top and bottom of the 9x16 are cut)
    var fill = Math.max(1080 / src.videoFrameWidth, 1350 / src.videoFrameHeight) * 100;
    var clip = seq.videoTracks[0].clips[0];
    for (var k = 0; clip && k < clip.components.numItems; k++) {
      if (clip.components[k].matchName !== 'AE.ADBE Motion') continue;
      clip.components[k].properties[1].setValue(fill, true); // scale
      clip.components[k].properties[0].setValue([0.5, 0.5], true); // position: centre
    }
    return pubsJson({ ok: true, created: true, name: name });
  } catch (e) { return pubsFail(e); }
}

// One file into Media Encoder's queue: the job's sequence (format 9x16) or its 4x5 sequence.
function pubs_exportAs(index, format, out, preset) {
  try {
    var s = pubsJob.sequences[index];
    var seq = format === '4x5' ? (pubsFindBin(pubsBin4x5(s.bin)) ? pubsFindSequence(s.name + ' 4x5', pubsFindBin(pubsBin4x5(s.bin))) : null) : pubsJobSequence(s);
    if (!seq) return pubsFail('Séquence introuvable : ' + s.name + (format === '4x5' ? ' 4x5' : ''));
    // last argument 0: the file stays in Media Encoder's queue once rendered, so the editor sees what was exported
    var id = app.encoder.encodeSequence(seq, new File(out).fsName, new File(preset).fsName, app.encoder.ENCODE_ENTIRE, 0);
    if (!id || id === '0') return pubsFail('Media Encoder a refusé ' + seq.name);
    return pubsJson({ ok: true, name: seq.name });
  } catch (e) { return pubsFail(e); }
}
function pubs_export(index, out, preset) {
  try {
    var s = pubsJob.sequences[index];
    var seq = pubsJobSequence(s);
    if (!seq) return pubsFail('Séquence introuvable : ' + s.name);
    var id = app.encoder.encodeSequence(seq, new File(out).fsName, new File(preset).fsName, app.encoder.ENCODE_ENTIRE, 0);
    if (!id || id === '0') return pubsFail('Media Encoder a refusé ' + s.name);
    return pubsJson({ ok: true, name: s.name });
  } catch (e) { return pubsFail(e); }
}

// Opens Media Encoder before anything is sent: a file sent while it is still starting can be lost.
function pubs_launchEncoder() {
  try {
    app.encoder.launchEncoder();
    return pubsJson({ ok: true });
  } catch (e) { return pubsFail(e); }
}

function pubs_exportStart() {
  try {
    app.encoder.startBatch();
    return pubsJson({ ok: true });
  } catch (e) { return pubsFail(e); }
}

// Leaves the rushes as they were found: no In/Out left on them in the bin.
function pubs_finish() {
  try {
    for (var id in pubsItems) {
      if (!pubsItems.hasOwnProperty(id)) continue;
      pubsItems[id].clearInPoint();
      pubsItems[id].clearOutPoint();
    }
    pubsJob = null;
    return pubsJson({ ok: true });
  } catch (e) { return pubsFail(e); }
}
