# 🧑‍🚀 AI 虚拟形象 · 3D 表情驱动（网页版）

VTuber / Animoji 风格：摄像头追踪你的表情，**实时驱动一个 3D 虚拟形象**——你转头它转头，你眨眼、张嘴、微笑，它都跟着模仿。纯前端，浏览器本地运行，画面不上传。

## 功能
- **实时表情驱动**：MediaPipe 输出 52 个 ARKit 表情系数 + 头部 3D 姿态，驱动 3D 模型的口型、眨眼、眼球朝向、转头。
- **3D 虚拟形象**：标准 **VRM** 格式（VTuber 通用），内置一个默认形象，也可以**上传你自己的 `.vrm`**。
- 可调 **平滑度 / 转头幅度**，可切换**镜像（自拍模式）**，左下角有摄像头小预览。
- 拖动旋转视角、滚轮缩放。

## 运行方式
摄像头 API 和 ES 模块需要通过 `http://localhost` 访问，不能直接双击 `index.html`。

```bash
# Python（系统一般自带）
python -m http.server 8000
# 或 Node
npx serve .
```

浏览器打开 **http://localhost:8000**，允许摄像头权限即可。

> 首次会从 CDN 下载 three.js、three-vrm、MediaPipe 模型和默认 VRM 形象（约 10MB+），需要联网，之后浏览器会缓存。

## 目录结构
```
85_AI换脸/
├── index.html        # 页面 + importmap（three / three-vrm 的 CDN 映射）
├── css/style.css     # 样式
├── js/app.js         # 核心：three.js 场景、VRM 加载、MediaPipe 追踪、表情驱动
└── README.md
```

## 技术说明
- 渲染：[three.js](https://threejs.org) + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)
- 追踪：[MediaPipe FaceLandmarker](https://ai.google.dev/edge/mediapipe)，开启 `outputFaceBlendshapes` 和 `outputFacialTransformationMatrixes`
- 表情映射：blendshapes → VRM 表情（`aa` 张嘴、`ih` 微笑、`ou` 嘟嘴、`blinkLeft/Right` 眨眼、`look*` 眼球）；头部姿态矩阵 → `neck` + `head` 骨骼旋转。

## 调试小贴士
如果**转头方向反了**（比如你向左它向右），改 `js/app.js` 顶部的 `HEAD_SIGN`：
```js
const HEAD_SIGN = { pitch: 1, yaw: -1, roll: -1 };  // 把对应轴的 +1/-1 反过来即可
```
眨眼左右反了，就关掉/打开「镜像」开关。

## 想要逼真的"真人换脸"（deepfake）？
本项目是 **3D 卡通形象驱动**——立体、跟随表情、实时、隐私安全，但形象是卡通角色。
如果你要把脸换成另一个**真人**的逼真效果，需要 inswapper / SimSwap 这类重模型 + 后端 GPU，无法在浏览器实时完成。需要的话可以再单独做一个后端方案。
```
