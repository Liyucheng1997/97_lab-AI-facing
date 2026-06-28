# 🧑‍🚀 AI 虚拟形象 · 3D 表情 / 身体动作驱动（网页版）

VTuber / Animoji 风格：摄像头追踪你的表情和身体动作，**实时驱动一个 3D 虚拟形象**——你转头它转头，你眨眼、张嘴、微笑、抬手、屈肘，它都跟着模仿。纯前端，浏览器本地运行，画面不上传。

## 功能
- **实时表情驱动**：MediaPipe 输出 52 个 ARKit 表情系数 + 头部 3D 姿态，驱动 3D 模型的口型、眨眼、眼球朝向、转头。
- **实时身体驱动**：MediaPipe PoseLandmarker 识别肩、肘、腕、髋、膝、踝等人体关键点，映射到 VRM 四肢骨骼，支持身体幅度调节。
- **3D 虚拟形象**：标准 **VRM** 格式（VTuber 通用），内置一个默认形象，也可以**上传你自己的 `.vrm`**。
- 可调 **平滑度 / 转头幅度**，可切换**镜像（自拍模式）**，左下角有摄像头小预览。
- 拖动旋转视角、滚轮缩放。

## 运行方式（OpenPose 后端）
这个项目现在默认使用本地 OpenPose 后端驱动身体，脸部仍在浏览器本地追踪。

1. 启动 OpenPose 后端：

```bat
start-openpose-backend.bat
```

后端监听 **ws://127.0.0.1:8765**。保持这个窗口运行。

2. 另开一个终端启动网页：

```bash
python -m http.server 8000
```

3. 浏览器打开 **http://localhost:8000**，允许摄像头权限，确认「使用 OpenPose 后端」已勾选。

调试时勾选「预览里显示身体关键点」：
- 预览上会画 OpenPose 的 BODY_25 原始骨架、关键点编号和名称。
- 绿色点表示置信度较高，橙色点表示置信度偏低。
- 左上角会显示 `visible` 和 `mapped to VRM`。如果 `visible` 为 0，问题在 OpenPose 识别；如果 `visible` 正常但模型不动，问题在 BODY_25 到 VRM 骨骼映射或当前 VRM 模型的骨骼约束。

本机已配置：
- OpenPose CPU 版：`vendor/openpose-cpu`
- Python 3.7 运行时：`vendor/python37`
- BODY_25 模型：`vendor/openpose-cpu/models/pose/body_25/pose_iter_584000.caffemodel`

启动脚本会临时把 `vendor/openpose-cpu` 挂载为 `O:`，让 OpenPose 看到纯英文路径，避免 Python/DLL 在中文路径下加载失败。文件仍然都在当前项目目录里。

> 当前可用的是 CPU 版 OpenPose，单帧约 1 秒，只适合验证身体驱动链路。官方 GPU 预编译包在 RTX 5080 上会卡住，若要流畅实时，需要从源码用本机 CUDA/CuDNN 重新编译 OpenPose。

## GPU OpenPose 编译状态
尝试过源码 GPU 编译准备，但 OpenPose CMake 需要下载 `opencv_420...zip`、`caffe3rdparty...zip`、`caffe...zip` 这 3 个 Windows 依赖包；官方 `posefs1.perception.cs.cmu.edu` DNS 失败，备用 `vcl.snu.ac.kr` 返回 502。相关临时源码和 CUDA 环境已清理，不随项目保留。

## 身体姿态校正
如果 OpenPose 左下角骨架是对的，但 VRM 手臂方向不对，优先调这两个开关：

- 「上下翻转身体点」：修正手臂上下方向反的问题，默认开启。
- 「左右交换身体点」：修正左右手臂互换的问题。

这两个开关只影响 VRM 驱动，不影响左下角 OpenPose 原始关键点显示。

## 运行方式（纯浏览器回退）
摄像头 API 和 ES 模块需要通过 `http://localhost` 访问，不能直接双击 `index.html`。

```bash
# Python（系统一般自带）
python -m http.server 8000
# 或 Node
npx serve .
```

浏览器打开 **http://localhost:8000**，允许摄像头权限，关闭「使用 OpenPose 后端」即可回退到 MediaPipe PoseLandmarker。

> 首次会从 CDN 下载 three.js、three-vrm、MediaPipe 人脸/身体模型和默认 VRM 形象（约 10MB+），需要联网，之后浏览器会缓存。

## 目录结构
```
85_AI换脸/
├── index.html        # 页面 + importmap（three / three-vrm 的 CDN 映射）
├── css/style.css     # 样式
├── js/app.js         # 核心：three.js 场景、VRM 加载、MediaPipe 追踪、表情/身体驱动
└── README.md
```

## 技术说明
- 渲染：[three.js](https://threejs.org) + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm)
- 追踪：[MediaPipe FaceLandmarker / PoseLandmarker](https://ai.google.dev/edge/mediapipe)，开启 `outputFaceBlendshapes` 和 `outputFacialTransformationMatrixes`
- 表情映射：blendshapes → VRM 表情（`aa` 张嘴、`ih` 微笑、`ou` 嘟嘴、`blinkLeft/Right` 眨眼、`look*` 眼球）；头部姿态矩阵 → `neck` + `head` 骨骼旋转。
- 身体映射：Pose 关键点向量 → VRM 四肢骨骼方向；躯干使用肩线和髋线估计轻微倾斜。

## OpenPose 接入说明
后端入口是 `server/openpose_ws_server.py`。浏览器把摄像头帧压缩后发给 WebSocket，后端用 `pyopenpose` 运行 BODY_25，再转换成前端现有的 MediaPipe 风格 33 点数组。这样前端的 VRM 骨骼驱动逻辑可以复用。

OpenPose 的优势是身体关键点更稳定，缺点是官方 Windows 预编译 GPU 包很旧。当前 CPU 版能跑通链路，但不够流畅；要做实时动作，需要下一步编译 GPU 版或换用支持新显卡的姿态模型。

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
