# VideoGrab Pro - 全能视频下载器

一个 Chrome 浏览器扩展，支持从主流视频平台一键下载视频，自动去水印，支持 4K 画质。

## 支持平台

- YouTube
- TikTok / 抖音
- Instagram
- B站（哔哩哔哩）
- 小红书
- 以及更多...

## 项目结构

```
VideoGrab-Extension/
├── extension/          # 浏览器扩展源码（加载到 Chrome 的文件夹）
│   ├── manifest.json
│   ├── popup.html / popup.js
│   ├── background.js
│   ├── content.js
│   ├── options.html / options.js
│   ├── icons/
│   └── _locales/       # 多语言支持（中文 / 英文）
│
└── server/             # 本地下载服务（Python）
    ├── server.py
    ├── requirements.txt
    ├── install_windows.bat
    └── install_mac_linux.sh
```

## 安装方法

### 第一步：启动本地服务

扩展需要配合一个本地 Python 服务来执行下载任务。

**Windows：**
```
双击运行 server/install_windows.bat
```

**macOS / Linux：**
```bash
cd server
chmod +x install_mac_linux.sh
./install_mac_linux.sh
```

服务启动后默认运行在 `http://127.0.0.1` 上。

### 第二步：加载浏览器扩展

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目的 `extension/` 文件夹

完成！工具栏会出现 VideoGrab 图标，打开视频页面点击即可下载。

## 使用说明

1. 打开任意支持的视频平台页面
2. 点击浏览器工具栏中的 VideoGrab 图标
3. 选择画质和格式
4. 点击下载

## 手动安装 Python 依赖

如果安装脚本运行失败，可以手动安装：

```bash
pip install -r server/requirements.txt
python server/server.py
```

## 版本

v2.3
