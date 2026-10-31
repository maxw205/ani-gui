// Anime4K upscaling on the GPU (WebGPU), using the presets from anime4k-webgpu (MIT,
// https://github.com/Anime4KWebBoost/Anime4K-WebGPU).
//
// The <video> element keeps decoding (and playing the sound); every frame it presents is
// copied to a GPU texture, run through an Anime4K preset and drawn into a <canvas> laid over
// it, at the canvas's real pixel size. The package's own render() helper can't be stopped
// and fixes its sizes once, so this drives the preset pipelines itself.

import { ModeA, ModeAA, ModeB, ModeBB, ModeC, ModeCA } from "anime4k-webgpu";

/** Upscaler menu value -> [label, preset class]. Anime4K's modes: A suits 1080p sources, B 720p, C 480p. */
export const UPSCALERS = {
  off: ["Upscaler off", null],
  a: ["Anime4K A", ModeA],
  b: ["Anime4K B", ModeB],
  c: ["Anime4K C", ModeC],
  aa: ["Anime4K A+A", ModeAA],
  bb: ["Anime4K B+B", ModeBB],
  ca: ["Anime4K C+A", ModeCA],
};

// draws a texture into the viewport (one triangle covering it)
const DRAW_SHADER = /* wgsl */ `
@group(0) @binding(0) var source_sampler: sampler;
@group(0) @binding(1) var source: texture_2d<f32>;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex fn vertex_main(@builtin(vertex_index) i: u32) -> Varyings {
  var corners = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: Varyings;
  out.position = vec4f(corners[i], 0.0, 1.0);
  out.uv = vec2f((corners[i].x + 1.0) * 0.5, (1.0 - corners[i].y) * 0.5);
  return out;
}

@fragment fn fragment_main(in: Varyings) -> @location(0) vec4f {
  return textureSample(source, source_sampler, in.uv);
}`;

/**
 * Sets up WebGPU on `canvas`. Throws when WebGPU isn't available.
 * `onError(message)` is called if the GPU is lost later on.
 */
export async function createUpscaler(canvas, { onError } = {}) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU isn't available");
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    if (info.reason !== "destroyed") onError?.(`GPU lost: ${info.message}`);
  });
  // WebGPU reports failed GPU commands only through this event
  device.addEventListener("uncapturederror", (event) => console.error(`[upscaler] ${event.error.message}`));

  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const module = device.createShaderModule({ code: DRAW_SHADER });
  const drawPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vertex_main" },
    fragment: { module, entryPoint: "fragment_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

  let video = null;
  let Preset = null;
  let input = null; // the video frame, at the video's own size
  let preset = null;
  let drawBindGroup = null;
  let built = ""; // what the current pipeline was built for
  let generation = 0; // bumped to end a running frame loop

  /** The video's area inside the canvas, keeping its aspect ratio (black bars around it). */
  function viewport() {
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    return { x: Math.floor((canvas.width - width) / 2), y: Math.floor((canvas.height - height) / 2), width, height };
  }

  /** (Re)builds the preset for the current video and canvas size, if those changed. */
  function build() {
    if (!video?.videoWidth) return false;
    const view = viewport();
    const key = `${video.videoWidth}x${video.videoHeight}>${view.width}x${view.height}:${Preset?.name}`;
    if (key === built) return true;
    built = key;
    if (!input || input.width !== video.videoWidth || input.height !== video.videoHeight) {
      input?.destroy();
      input = device.createTexture({
        size: [video.videoWidth, video.videoHeight],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    preset = new Preset({
      device,
      inputTexture: input,
      nativeDimensions: { width: video.videoWidth, height: video.videoHeight },
      targetDimensions: { width: view.width, height: view.height },
    });
    drawBindGroup = device.createBindGroup({
      layout: drawPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: preset.getOutputTexture().createView() },
      ],
    });
    return true;
  }

  /** Runs the preset on the last copied frame and draws it. */
  function draw() {
    if (!build()) return;
    const encoder = device.createCommandEncoder();
    preset.pass(encoder);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }],
    });
    const view = viewport();
    pass.setViewport(view.x, view.y, view.width, view.height, 0, 1);
    pass.setPipeline(drawPipeline);
    pass.setBindGroup(0, drawBindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  function copyFrame() {
    if (!video.videoWidth || !build()) return false;
    device.queue.copyExternalImageToTexture({ source: video }, { texture: input }, [video.videoWidth, video.videoHeight]);
    return true;
  }

  return {
    /** Starts upscaling `videoElement` with the preset for `mode` (a key of UPSCALERS). */
    start(videoElement, mode) {
      video = videoElement;
      Preset = UPSCALERS[mode]?.[1];
      if (!Preset) return;
      built = "";
      const mine = ++generation;
      // every frame the video presents, including while paused (after a seek)
      const onFrame = () => {
        if (mine !== generation) return;
        if (copyFrame()) draw();
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
      if (copyFrame()) draw(); // the frame that's already showing
    },

    /** Call after the canvas's pixel size changed: rebuilds for the new size and redraws. */
    resize() {
      if (video && Preset && input) draw();
    },

    stop() {
      generation++;
    },

    destroy() {
      generation++;
      input?.destroy();
      device.destroy();
    },
  };
}
