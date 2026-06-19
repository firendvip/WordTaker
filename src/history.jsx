import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import HistoryModal from "./components/ui/history-modal";

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

  // 搜索功能
  React.useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredTranscriptions(transcriptions);
    } else {
      const filtered = transcriptions.filter(item => 
        item.text?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.processed_text?.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredTranscriptions(filtered);
    }
  }, [searchQuery, transcriptions]);

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
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100 chinese-title flex-shrink-0">历史记录</h1>
            <div className="relative w-64 max-w-[60%]">
              <svg className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="搜索转录内容..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-white rounded-xl focus:ring-1 focus:ring-neutral-400 focus:border-transparent chinese-text text-sm"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              共 {filteredTranscriptions.length} 条记录
            </span>
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