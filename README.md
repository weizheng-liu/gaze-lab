[English](#english)

# 目光 · Gaze Lab

用普通摄像头估算屏幕注视位置。V1.4.1 提供免校准全屏观察、9 点和 16 点个人校准，以及针对前后移动的近／远补充校准。独立测试记录同一批帧的原始预测和补偿误差。相机画面和推理都留在本机。

## 运行

安装 Python 3.11+ 和 Chrome 或 Edge。在项目目录首次运行：

```powershell
python scripts/setup_vendor.py
python scripts/setup_compensation.py
.\start.cmd
```

前两条命令从上游取得固定版本的依赖并验证校验值。安装完成后可离线运行。Windows 启动脚本默认打开 [localhost:8765](http://localhost:8765/)。也可以运行 `python server.py` 前台启动。

连接摄像头后可以直接全屏观察，或先完成个人校准，再做坐稳或轻微移动测试。需要保留的结果可导出 CSV 或 JSON。自然移动是实验功能，实际精度随摄像头、坐姿和光线变化。

## 测试

```powershell
node --test tests/core.test.mjs tests/regression.test.mjs tests/precision.test.mjs tests/compensation.test.mjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/setup_test_fixture.py
python tests/run_browser.py
python tests/run_browser.py tests/pretrained.test.mjs
```

浏览器检查需要 Chrome 和 Playwright。用 `PLAYWRIGHT_MODULE` 指定 Playwright 的 `index.mjs`，用 `CHROME_PATH` 指定 Chrome 路径。检查使用合成相机和上游测试照片。 [第三方来源及许可](THIRD_PARTY_NOTICES.md)

## English

Gaze Lab estimates where you are looking on a screen using an ordinary webcam. Version 1.4.1 supports calibration-free fullscreen exploration, 9- or 16-point personal calibration, and optional near/far calibration. Independent tests compare raw predictions on the same frames. Camera frames and inference stay on the device.

### Run locally

Install Python 3.11+ and Chrome or Edge. Run the following from the project directory on first setup:

```powershell
python scripts/setup_vendor.py
python scripts/setup_compensation.py
.\start.cmd
```

The setup scripts download and verify pinned dependencies. The app runs offline after setup. The Windows launcher opens [localhost:8765](http://localhost:8765/) by default. To keep the server in the foreground, run `python server.py`.

Connect the webcam and try fullscreen tracking or calibrate first. Separate tests measure accuracy when seated still or moving slightly. Export CSV or JSON to keep results across reloads. Movement tracking is experimental, and real-world accuracy varies with camera, posture, and lighting.

### Test

```powershell
node --test tests/core.test.mjs tests/regression.test.mjs tests/precision.test.mjs tests/compensation.test.mjs
python -m unittest discover -s tests -p "test_*.py"
python scripts/setup_test_fixture.py
python tests/run_browser.py
python tests/run_browser.py tests/pretrained.test.mjs
```

Browser checks require Chrome and Playwright. Set `PLAYWRIGHT_MODULE` to Playwright's `index.mjs` and use `CHROME_PATH` to override the browser executable. Checks use a synthetic camera and an upstream fixture. [Third-party sources and licenses](THIRD_PARTY_NOTICES.md)
