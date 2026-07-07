import React, { useState } from "react";
import { toast } from "sonner";
import { Share2, Copy, Check } from "lucide-react";

// 我的邀请码卡：显示 inviteCode，一键复制码 + 复制邀请文案。仅登录后展示。
// props: { inviteCode, variant }
//   variant="card"(默认)     —— 独立白卡样式
//   variant="onGradient"     —— 渐变卡内的毛玻璃分区（供「一体化会员卡」复用），码+复制码+分享同一行
export function InviteCard({ inviteCode, variant = "card" }) {
  const [copied, setCopied] = useState("");

  if (!inviteCode) return null;

  const onGrad = variant === "onGradient";

  const copy = async (text, tag, okMsg) => {
    try {
      // 优先走主进程剪贴板（Electron 渲染进程里 navigator.clipboard 常因焦点/权限失效）；失败再退回 Web API。
      if (window.electronAPI?.copyText) {
        await window.electronAPI.copyText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied(tag);
      toast.success(okMsg);
      setTimeout(() => setCopied(""), 1500);
    } catch (e) {
      toast.error("复制失败，请手动复制");
    }
  };

  const inviteText = `我在用「弦外小猫」AI语音输入，能帮你把重复的，说错的自动纠正，超好用！用我的邀请码 ${inviteCode} 注册，双方都能拿字数奖励！`;

  const wrapCls = onGrad
    ? "rounded-[13px] p-3 bg-white/[0.14] border border-white/20"
    : "rounded-2xl border border-gray-100 dark:border-neutral-800 p-4";
  const titleCls = onGrad
    ? "text-[13px] font-medium text-white/90"
    : "text-[14px] font-medium text-gray-900 dark:text-gray-100";
  const iconCls = onGrad ? "w-4 h-4 text-white/90" : "w-4 h-4 text-indigo-500";
  const codeCls = onGrad
    ? "flex-1 min-w-0 px-3 py-2 rounded-lg bg-white/[0.16] text-[15px] font-mono font-semibold tracking-[0.14em] text-white select-all"
    : "flex-1 min-w-0 px-3 py-2 rounded-lg bg-gray-50 dark:bg-neutral-800 text-[16px] font-mono font-semibold tracking-[0.15em] text-gray-900 dark:text-gray-100 select-all";
  const btnCls = onGrad
    ? "flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-white/20 text-white hover:bg-white/30 transition-colors"
    : "flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-200 hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors";

  return (
    <div className={wrapCls}>
      <div className="flex items-center gap-2 mb-3">
        <Share2 className={iconCls} />
        <span className={titleCls}>我的邀请码</span>
      </div>
      <div className="flex items-center gap-2">
        <code className={codeCls}>{inviteCode}</code>
        <button
          type="button"
          onClick={() => copy(inviteCode, "code", "邀请码已复制")}
          className={btnCls}
        >
          {copied === "code" ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
          复制码
        </button>
        {onGrad && (
          <button
            type="button"
            onClick={() => copy(inviteText, "text", "邀请文案已复制，去分享吧")}
            className={btnCls}
          >
            {copied === "text" ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
            分享
          </button>
        )}
      </div>
      {!onGrad && (
        <button
          type="button"
          onClick={() => copy(inviteText, "text", "邀请文案已复制，去分享吧")}
          className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
        >
          {copied === "text" ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
          复制邀请文案
        </button>
      )}
    </div>
  );
}

export default InviteCard;
