# 暖色手账 · Warm Journal

温暖桃色纸感的按日手账，数据保存在浏览器本地（`localStorage`）。

## 使用

1. 打开页面，在月历上点选日期
2. 在底部抽屉中写标题与 Markdown 正文
3. 失焦 / 定时自动保存，也可点「保存」
4. 有笔记的日期会显示小圆点；今天高亮显示
5. 底部导出栏：MD / JSON / PDF / DOCX / 图片；「全部」导出全部笔记的 JSON + 合并 Markdown

## 在线地址（GitHub Pages）

https://junjiewq.github.io/warm-notebook/

## 本地预览

直接用浏览器打开 `index.html`，或：

```bash
cd warm-notebook
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

## 技术

- EasyMDE（Markdown 编辑）
- marked / html2pdf.js / html2canvas / html-docx-js / FileSaver（导出）
- 纯前端，无后端
