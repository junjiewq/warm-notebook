# 暖色手账 · Warm Journal

温暖桃色纸感的双轴手账：**按日期**记每日笔记，**按学习线（主题）**串联多科目学习。数据保存在浏览器 `localStorage`。

## 在线地址

https://junjiewq.github.io/warm-notebook/

## 功能

1. **日历**：点选日期写 Markdown；有笔记的日子显示圆点
2. **学习线**：自建主题（示例种子：PolarDB / Java / 英语，可删可改）；点进主题按时间看全部笔记
3. **日记挂主题**：编辑某天时用标签多选挂上一条或多条学习线
4. **可选模板**：目标 / 学到了 / 主题 / 疑问
5. **导出**：当日、全部（按日）、按主题 → MD / JSON / PDF / DOCX / 图片

## 如何添加新主题

- **学习线**页点「＋ 新建主题」，输入任意名称即可  
- 或在编辑某天时点「＋ 新主题」，新建后会自动勾选到当天

## 响应式

| 宽度 | 布局 |
|------|------|
| ~380px | 单栏；日历触控；编辑器全屏抽屉；导出按钮换行 |
| ≥768px | 加宽日历；编辑器居中抽屉 |
| ≥1000px / 1200px | 日历 + 学习线并排两栏；大屏更舒适 |

输入框字号 ≥16px（避免 iOS 缩放），触控目标约 44px，支持 safe-area。

## 本地预览

```bash
cd warm-notebook
python3 -m http.server 8080
```

访问 `http://localhost:8080`。

## 技术

EasyMDE、marked、html2pdf.js、html2canvas、html-docx-js、FileSaver；纯前端，无后端。
