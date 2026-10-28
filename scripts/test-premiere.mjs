// Premiere export: frame maths, margins, montage order and the .xml itself.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { frameRate, planCuts, premiereXml, parseProbe, PAD_IN, PAD_OUT } from '../src/lib/premiere.js';

let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' → ' + detail}`); };

// ---- rates
const r = (fps) => { const x = frameRate(fps); return `${x.timebase}${x.ntsc ? 'n' : ''}`; };
check('standard rates', r(25) === '25' && r(29.97) === '30n' && r(30) === '30' && r(23.98) === '24n' && r(59.94) === '60n', [25, 29.97, 30, 23.98, 59.94].map(r).join(' '));
check('phone rates snap to the nearest', r(60.01) === '60' && r(29.99) === '30' && r(0) === '25' && r(undefined) === '25');
check('29.97 counts real time', Math.abs(frameRate(29.97).fps - 30000 / 1001) < 1e-9);

// ---- words: 250 ms apart, 220 ms long (30 ms between words), a 1 s pause before "Le"
const say = (text, t0) => text.split(' ').map((w, i) => ({ text: w, start: t0 + i * 250, end: t0 + i * 250 + 220 }));
const words = [
  ...say('Bon alors je vais vous raconter', 0), //      0 → 1470
  ...say('personne ne croyait en moi', 2500), //        2500 → 3720
  ...say('et aujourd’hui on fait trois millions', 4720), // 4720 → 6190
  ...say('le secret c’est la régularité', 7000), //     7000 → 8220
];
const span = (a, b) => ({ start: words[a].start, end: words[b].end, text: words.slice(a, b + 1).map((w) => w.text).join(' ') });
const moment = {
  title: 'Trois millions',
  hook: { ...span(11, 16), why: 'Un chiffre fort.' }, // "et aujourd'hui … millions"
  body: [{ ...span(6, 10), label: 'Personne n’y croyait' }, { ...span(17, 21), label: 'Le secret' }],
  headlines: ['De zéro à 3 millions', 'Le vrai secret', 'Personne n’y croyait'],
};
const rate = frameRate(25);
const plan = planCuts(moment, words, 9000, rate);
const f = (ms) => (ms / 1000) * 25;

check('hook first, then the body in order', plan.clips.length === 3 && plan.clips[0].in === Math.floor(f(4720 - PAD_IN)) && plan.clips[1].in < plan.clips[0].in && plan.clips[2].in > plan.clips[0].out, JSON.stringify(plan.clips));
check('hook starts at frame 0 of the sequence', plan.clips[0].start === 0);
// hook: 1 s of silence before (3720 → 4720) and 810 ms after (6190 → 7000) → full margins
check('margin before a word after a pause = PAD_IN', plan.clips[0].in === Math.floor(f(4720 - PAD_IN)), JSON.stringify(plan.clips[0]));
check('margin after a word before a pause = PAD_OUT', plan.clips[0].out === Math.ceil(f(6190 + PAD_OUT)), JSON.stringify(plan.clips[0]));
// "personne" → "ne": 30 ms between the words → the margin takes only half of it
const tight = planCuts({ ...moment, body: [], hook: { ...span(7, 10), why: '' } }, words, 9000, rate).clips[0];
check('margin never reaches the neighbouring word', tight.in === Math.floor(f(2750 - 15)) && (tight.in / 25) * 1000 > 2500 + 220 - 40, JSON.stringify(tight));
check('body 1 keeps its margins', plan.clips[1].in === Math.floor(f(2500 - PAD_IN)) && plan.clips[1].out === Math.ceil(f(3720 + PAD_OUT)), JSON.stringify(plan.clips[1]));
check('clips are back to back', plan.clips.every((c, k) => c.start === (k ? plan.clips[k - 1].end : 0) && c.end - c.start === c.out - c.in));
check('sequence length = sum of clips', plan.frames === plan.clips.at(-1).end);

// passages that touch in the source → one clip
const touching = { ...moment, hook: { ...span(6, 7), why: '' }, body: [{ ...span(8, 10), label: 'suite' }] };
const tp = planCuts(touching, words, 9000, rate);
check('touching passages become one clip', tp.clips.length === 1 && tp.clips[0].in === Math.floor(f(2500 - PAD_IN)) && tp.clips[0].out === Math.ceil(f(3720 + PAD_OUT)), JSON.stringify(tp));
// the last word of the file: margin stops at the end of the media
const end = planCuts({ ...moment, body: [], hook: { ...span(17, 21), why: '' } }, words, 8300, rate);
check('never past the end of the file', end.clips[0].out === Math.floor((8300 / 1000) * 25), JSON.stringify(end.clips[0]));

// ---- probe (real ffmpeg banners: camera file, phone file, mp3)
const cam = parseProbe(`  Duration: 00:01:04.70, start: 0.000000, bitrate: 35223 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 34996 kb/s, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 12800 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 232 kb/s (default)`);
check('probe: camera file', cam.duration === 64700 && cam.video.width === 1920 && cam.video.height === 1080 && cam.video.fps === 25 && cam.audio.channels === 2 && cam.audio.rate === 48000, JSON.stringify(cam));
const phone = parseProbe(`  Duration: 00:00:13.98, start: 0.000000, bitrate: 497 kb/s
  Stream #0:0[0x1](eng): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 387 kb/s, 60.01 fps, 60 tbr, 1000k tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 101 kb/s (default)`);
check('probe: phone file (rotated, mono)', phone.video.rotation === -90 && phone.video.fps === 60.01 && phone.audio.channels === 1 && phone.audio.rate === 44100, JSON.stringify(phone));
const mp3 = parseProbe(`  Duration: 00:00:46.49, start: 0.000000, bitrate: 204 kb/s
  Stream #0:0: Audio: mp3, 48000 Hz, stereo, fltp, 192 kb/s`);
check('probe: mp3', mp3.duration === 46490 && !mp3.video && mp3.audio.channels === 2);

// ---- the .xml
const path = "/Users/x/Desktop/Tournage - Mai/JOUR 5/15 - Un seul produit 2.mp4";
const xml = premiereXml({ moment, index: 0, words, media: { ...cam, duration: 9000 }, path, name: path.split('/').pop() });
const count = (re) => (xml.match(re) || []).length;
check('sequence named after the clip', xml.includes('<name>15 - Un seul produit 2 - Hook 1</name>'));
check('vertical 1080×1920 at the file’s rate', xml.includes('<width>1080</width><height>1920</height>') && xml.includes('<timebase>25</timebase><ntsc>FALSE</ntsc>'));
check('horizontal video scaled to fill', xml.includes('<value>177.7778</value>'));
check('one video + a left/right audio clip per cut, linked', count(/<clipitem id="clipitem-v/g) === 3 && count(/<clipitem id="clipitem-a1-/g) === 3 && count(/<clipitem id="clipitem-a2-/g) === 3 && count(/<linkclipref>/g) === 27);
check('file defined once, then referenced', count(/<file id="file-1">/g) === 1 && count(/<file id="file-1"\/>/g) === 8);
check('channel 1 and 2 of the file, like Premiere writes stereo', count(/<trackindex>1<\/trackindex><\/sourcetrack>/g) === 3 && count(/<trackindex>2<\/trackindex><\/sourcetrack>/g) === 3 && xml.includes('totalExplodedTrackCount="2"'));
check('path is a file url', xml.includes('<pathurl>file://localhost/Users/x/Desktop/Tournage%20-%20Mai/JOUR%205/15%20-%20Un%20seul%20produit'));
check('no markers', count(/<marker>/g) === 0);
check('stereo audio track', xml.includes('premiereTrackType="Stereo"') && xml.includes('premiereChannelType="stereo"'));

const vertical = premiereXml({ moment, index: 1, words, media: { ...phone, duration: 9000 }, path: '/a/b.MOV', name: 'b.MOV' });
check('rotated phone video: already vertical, 100 %', vertical.includes('<value>100.0000</value>') && vertical.includes('<width>1080</width><height>1920</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>') && vertical.includes('<timebase>60</timebase>'));
check('mono audio: one track', vertical.includes('premiereTrackType="Mono"') && vertical.match(/<clipitem id="clipitem-a/g).length === 3 && !vertical.includes('clipitem-a2-'));

const audioOnly = premiereXml({ moment, index: 0, words, media: { ...mp3, duration: 9000 }, path: '/a/clip.mp3', name: 'clip.mp3' });
check('mp3: audio-only sequence', !audioOnly.includes('clipitem-v') && audioOnly.match(/<clipitem id="clipitem-a/g).length === 6 && audioOnly.match(/<file id="file-1">/g).length === 1 && audioOnly.indexOf('<file id="file-1">') < audioOnly.indexOf('<file id="file-1"/>'));
const amp = premiereXml({ moment, index: 0, words, media: cam, path: '/a/R&D <1>.mp4', name: 'R&D <1>.mp4' });
check('names are escaped', amp.includes('<name>R&amp;D &lt;1&gt; - Hook 1</name>') && amp.includes('R%26D%20%3C1%3E.mp4'));

if (existsSync('/usr/bin/xmllint')) {
  const wellFormed = (x) => { try { execFileSync('/usr/bin/xmllint', ['--noout', '-'], { input: x, stdio: ['pipe', 'ignore', 'pipe'] }); return true; } catch { return false; } };
  check('well-formed XML (video, phone, mp3)', wellFormed(xml) && wellFormed(vertical) && wellFormed(audioOnly));
}

process.exit(fail ? 1 : 0);
