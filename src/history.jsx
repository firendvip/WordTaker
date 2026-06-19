import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

// 历史记录页面组件
const HistoryPage = () => {
  const handleCopy = async (text, event) => {
    // 同步捕获按钮位置（React 在异步 await 后会清空 event.currentTarget）
    const btn = event?.currentTarget;
    const rect = btn ? btn.getBoundingClientRect() : null;
    try {
      if (window.electronAPI) {
        await window.electronAPI.copyText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      showCopyToast(rect);
    } catch (error) {
      console.error("复制失败:", error);
    }
  };

  // 绿色“复制成功”小弹窗，显示在被点击的复制按钮正上方
  const showCopyToast = (rect) => {
    const toast = document.createElement('div');
    toast.textContent = '复制成功';
    toast.className =
      'fixed bg-green-500 text-white px-3 py-1.5 rounded-lg shadow-lg z-50 text-sm pointer-events-none transition-opacity';
    toast.style.visibility = 'hidden';
    document.body.appendChild(toast);
    if (rect) {
      const tRect = toast.getBoundingClientRect();
      toast.style.left = `${Math.round(rect.left + rect.width / 2 - tRect.width / 2)}px`;
      toast.style.top = `${Math.round(rect.top - tRect.height - 8)}px`;
    } else {
      toast.style.left = '50%';
      toast.style.top = '16px';
    }
    toast.style.visibility = 'visible';
    setTimeout(() => {
      if (toast.parentNode) document.body.removeChild(toast);
    }, 1500);
  };

  return (
    <div className="h-screen bg-gray-50 dark:bg-neutral-950 flex flex-col">
      {/* 历史记录内容（标题 + 搜索同一行，由 HistoryContent 渲染） */}
      <div className="flex-1 overflow-hidden min-h-0">
        <HistoryContent onCopy={handleCopy} />
      </div>
    </div>
  );
};

// 历史记录内容组件
const HistoryContent = ({ onCopy }) => {
  const [transcriptions, setTranscriptions] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [filteredTranscriptions, setFilteredTranscriptions] = React.useState([]);
  // 当前选中的记录（点击卡片选中，按 Delete/Backspace 删除）
  const [selectedId, setSelectedId] = React.useState(null);
  // 日期范围筛选：起止日期(按中国时区的 YYYY-MM-DD，空=不限)由用户选择
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");

  // 加载转录历史
  const loadTranscriptions = async () => {
    if (!window.electronAPI) return;
    
    setLoading(true);
    try {
      // -1 = SQLite LIMIT -1，不设上限，加载全部历史记录
      const result = await window.electronAPI.getTranscriptions(-1, 0);
      setTranscriptions(result || []);
      setFilteredTranscriptions(result || []);
    } catch (error) {
      console.error("加载历史记录失败:", error);
    } finally {
      setLoading(false);
    }
  };

  // 过滤：先按日期，再按搜索关键词（created_at 为 UTC，需按中国时区换算日期）
  React.useEffect(() => {
    const tz = "Asia/Shanghai";
    const dk = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const isoOf = (s) => (/T/.test(s) ? s : `${String(s || "").replace(" ", "T")}Z`);
    const dayKeyOf = (s) => {
      const d = new Date(isoOf(s));
      return isNaN(d.getTime()) ? "" : dk.format(d);
    };
    // 起止可任意单边留空；YYYY-MM-DD 字符串按字典序比较 = 按时间先后比较
    let list = transcriptions;
    if (fromDate || toDate) {
      list = list.filter((i) => {
        const k = dayKeyOf(i.created_at);
        if (!k) return false;
        if (fromDate && k < fromDate) return false;
        if (toDate && k > toDate) return false;
        return true;
      });
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) => i.text?.toLowerCase().includes(q) || i.processed_text?.toLowerCase().includes(q)
      );
    }
    setFilteredTranscriptions(list);
  }, [searchQuery, transcriptions, fromDate, toDate]);

  // 组件挂载时加载数据
  React.useEffect(() => {
    loadTranscriptions();
  }, []);

  // 删除转录记录
  const handleDelete = async (id) => {
    if (!window.electronAPI || id == null) return;

    try {
      await window.electronAPI.deleteTranscription(id);
      setTranscriptions(prev => prev.filter(item => item.id !== id));
      setSelectedId(prev => (prev === id ? null : prev));
    } catch (error) {
      console.error("删除记录失败:", error);
    }
  };

  // 选中卡片后，按 Mac 的 Delete / Backspace 键删除当前记录
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (selectedId == null) return;
      // 焦点在输入框（如搜索框）时不触发删除
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      e.preventDefault();
      if (window.confirm("确定删除这条记录吗？")) {
        handleDelete(selectedId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

  // 格式化日期
  // created_at 由 SQLite 以 UTC（"YYYY-MM-DD HH:MM:SS"）保存。必须按 UTC 解析，
  // 再统一以中国时间(Asia/Shanghai)显示，否则会被当成本地时间、出现差 8 小时的错误。
  const TZ = 'Asia/Shanghai';
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const timeFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const monthDayFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, month: 'long', day: 'numeric',
  });

  const formatDate = (dateString) => {
    if (!dateString) return '';
    // 把 SQLite 的 "YYYY-MM-DD HH:MM:SS"(UTC) 转成带 Z 的 ISO，明确按 UTC 解析
    const iso = /T/.test(dateString) ? dateString : `${dateString.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    if (isNaN(date.getTime())) return dateString;

    const time = timeFmt.format(date);
    const todayKey = dayKeyFmt.format(new Date());
    const dateKey = dayKeyFmt.format(date);
    if (dateKey === todayKey) return `今天 ${time}`;

    const yesterdayKey = dayKeyFmt.format(new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (dateKey === yesterdayKey) return `昨天 ${time}`;

    return `${monthDayFmt.format(date)} ${time}`;
  };

  return (
    <div className="h-full flex flex-col">
      {/* 顶部栏：标题（左）+ 搜索框（右）同一行 */}
      <div className="px-6 py-5 bg-white/70 dark:bg-neutral-950/70 backdrop-blur-md border-b border-gray-100 dark:border-neutral-900 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-baseline gap-2 flex-shrink-0">
              <h1 className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100 chinese-title">历史记录</h1>
              <span className="text-sm text-gray-500 dark:text-gray-400">{filteredTranscriptions.length} 条</span>
            </div>
            {/* 日期范围筛选：起止日期由用户选择（在历史记录右侧） */}
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                title="开始日期"
              />
              <span className="text-sm text-gray-400 dark:text-gray-500">至</span>
              <input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                className="px-3 py-1.5 rounded-lg text-sm border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                title="结束日期"
              />
              {(fromDate || toDate) && (
                <button
                  onClick={() => { setFromDate(""); setToDate(""); }}
                  className="px-2.5 py-1.5 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
                  title="清除日期筛选"
                >
                  清除
                </button>
              )}
            </div>
          </div>
          {/* 搜索（左）+ 刷新/导出（右） */}
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="relative w-64 max-w-[60%]">
              <svg className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="搜索转录内容..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-white rounded-xl focus:ring-1 focus:ring-neutral-400 focus:border-transparent chinese-text text-sm"
              />
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={loadTranscriptions}
                disabled={loading}
                className="flex items-center space-x-1.5 px-3.5 py-2 border border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors text-sm disabled:opacity-50"
                title="刷新列表"
              >
                <svg
                  className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>刷新</span>
              </button>
              <button
                onClick={() => {
                  if (window.electronAPI) {
                    window.electronAPI.exportTranscriptions('txt');
                  }
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm font-medium"
              >
                导出全部
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto p-6 min-h-0">
        <div className="max-w-3xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-neutral-400"></div>
              <span className="ml-3 text-gray-500 dark:text-gray-400">加载中...</span>
            </div>
          ) : filteredTranscriptions.length === 0 ? (
            <div className="text-center py-16">
              <svg className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <p className="text-gray-500 dark:text-gray-400 chinese-text text-base">
                {searchQuery ? "没有找到匹配的记录" : "暂无转录历史"}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredTranscriptions.map((item) => (
                <div
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`bg-white dark:bg-neutral-900 rounded-2xl p-6 shadow-sm hover:shadow-md transition-shadow cursor-pointer border ${
                    selectedId === item.id
                      ? "border-blue-500 ring-2 ring-blue-500/40 dark:border-blue-400"
                      : "border-gray-100 dark:border-neutral-800"
                  }`}
                >
                  <div className="flex items-center justify-between pb-4 mb-4 border-b border-gray-100 dark:border-neutral-800">
                    <div className="flex items-center space-x-3 text-sm text-gray-500 dark:text-gray-400">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span>{formatDate(item.created_at)}</span>
                      {item.confidence > 0 && (
                        <span className="bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 px-2 py-0.5 rounded-md text-xs">
                          置信度: {Math.round(item.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="flex space-x-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); onCopy(item.processed_text || item.text, e); }}
                        className="p-2.5 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                        title="复制文本"
                      >
                        <svg className="w-6 h-6 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("确定删除这条记录吗？")) handleDelete(item.id);
                        }}
                        className="p-2.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                        title="删除记录"
                      >
                        <svg className="w-6 h-6 text-red-500 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* AI优化（放在上面） */}
                  {item.processed_text && item.processed_text.trim() !== (item.raw_text || item.text || '').trim() && (
                    <div className="mb-4">
                      <h4 className="text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-2">AI优化</h4>
                      <p className="chinese-content leading-relaxed bg-gray-50 dark:bg-neutral-800/40 p-4 rounded-xl border border-gray-100 dark:border-neutral-700/30 text-gray-800 dark:text-gray-100">
                        {item.processed_text}
                      </p>
                    </div>
                  )}

                  {/* 原始识别（放在下面） */}
                  <div>
                    <h4 className="text-[13px] font-medium text-gray-500 dark:text-gray-400 mb-2">原始识别</h4>
                    <p className="chinese-content leading-relaxed bg-gray-50 dark:bg-neutral-800/60 p-4 rounded-xl border border-gray-100 dark:border-neutral-700/30 text-gray-700 dark:text-gray-200">
                      {item.raw_text || item.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// 渲染应用
const container = document.getElementById('history-root');
const root = createRoot(container);
root.render(<HistoryPage />);