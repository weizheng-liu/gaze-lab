# 第三方来源 · Third-party sources

The setup scripts obtain dependencies from upstream. The installers record the source URLs and checksums, and install license files alongside the dependencies.

| Dependency | Source and provenance |
|---|---|
| WebGazer 3.5.3 | [Brown WebGazer](https://github.com/brownhci/WebGazer). The license is taken from the pinned npm package. |
| MobileGaze MobileOne S0 | [Upstream model weights](https://github.com/yakhyo/gaze-estimation/releases/tag/weights) and [source license](https://github.com/yakhyo/gaze-estimation/blob/4bf557d8a819da2b208214a9ef9268fd84cb52f1/LICENSE). Upstream identifies Gaze360 as the training dataset. |
| ONNX Runtime Web 1.31.1 | [ONNX Runtime](https://github.com/microsoft/onnxruntime) and the [MIT license](licenses/onnxruntime-LICENSE.txt) saved from the upstream release. The installer verifies the text before copying it alongside the runtime. |
| MediaPipe canonical face model | [Source and data](https://github.com/google-ai-edge/mediapipe/tree/5338be56f67f4e27a0faf13a3877d1cf6e8624b5/mediapipe/modules/face_geometry) and [Apache 2.0 license](https://github.com/google-ai-edge/mediapipe/blob/5338be56f67f4e27a0faf13a3877d1cf6e8624b5/LICENSE). |
| Browser test portrait | TensorFlow.js Models test fixture. [Source and SHA-256](tests/fixtures/source.json). |
