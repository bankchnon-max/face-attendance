// Face AI in a background worker, so the page always responds to taps while faces are being analysed.
// The page sends camera frames as ImageBitmaps; the worker answers with plain detection results.
importScripts('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js');
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';

// face-api only knows browser pages and Node.js; describe the worker to it (canvases are OffscreenCanvas here)
class Unavailable {}
faceapi.env.setEnv({
  Canvas: OffscreenCanvas, CanvasRenderingContext2D: OffscreenCanvasRenderingContext2D, Image: Unavailable, ImageData, Video: Unavailable,
  createCanvasElement: () => new OffscreenCanvas(1, 1),
  createImageElement: () => { throw new Error('no images in worker'); },
  createVideoElement: () => { throw new Error('no video in worker'); },
  fetch: (...args) => fetch(...args),
  readFile: () => { throw new Error('no files in worker'); }
});

let opts;
const ready = (async () => {
  await faceapi.tf.setBackend('webgl');
  await faceapi.tf.ready();
  if (faceapi.tf.getBackend() !== 'webgl') throw new Error('no WebGL in worker');   // CPU would be far too slow
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
  ]);
  opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  // run each model once so the GPU programs are compiled before the first person scans
  const blank = faceapi.tf.zeros([160, 160, 3]);
  await faceapi.detectSingleFace(blank, opts);
  await faceapi.nets.faceLandmark68Net.detectLandmarks(blank);
  await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(blank);
  blank.dispose();
})();
ready.then(() => postMessage({ type: 'ready' }), e => postMessage({ type: 'fail', error: String(e && e.message || e) }));

self.onmessage = async ({ data: { id, bitmap, full } }) => {
  let input;
  try {
    await ready;
    input = faceapi.tf.browser.fromPixels(bitmap);
    bitmap.close();
    const q = faceapi.detectSingleFace(input, opts).withFaceLandmarks();
    const d = await (full ? q.withFaceDescriptor() : q);
    const b = d && d.detection.box;
    const det = d ? {
      detection: { box: { x: b.x, y: b.y, width: b.width, height: b.height }, score: d.detection.score },
      landmarks: { positions: d.landmarks.positions.map(p => ({ x: p.x, y: p.y })) },
      descriptor: d.descriptor ? new Float32Array(d.descriptor) : null
    } : null;
    postMessage({ id, det, tensors: faceapi.tf.memory().numTensors }, det && det.descriptor ? [det.descriptor.buffer] : []);
  } catch (e) {
    postMessage({ id, error: String(e && e.message || e) });
  } finally {
    if (input) input.dispose();
  }
};
