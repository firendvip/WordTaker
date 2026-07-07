import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Loader2, CheckCircle2, QrCode } from "lucide-react";

// 应用内支付宝扫码弹窗（业界常规收银台样式）。
// 优先手机端付款流程：后端返回 wapPayUrl（手机收银台链接）时，本地生成二维码展示，
// 用户手机支付宝「扫一扫」后直接在手机上打开付款页完成付款。
// 兜底：无 wapPayUrl（老后端）时回退 1.13.1 的 iframe 嵌入电脑收银台（payUrl 带 qr_pay_mode=4）。
// props: {
//   desc: 购买内容说明（如 "充值包 · 小包（云端10万字/1年）"）
//   amountYuan: 金额（元，字符串）
//   payUrl: 电脑收银台 URL（iframe 兜底 + 浏览器打开）
//   wapPayUrl: 手机收银台 URL（本地生成二维码，优先）
//   paid: 是否已到账（true 时展示成功态）
//   checking: 手动刷新额度进行中
//   onConfirmPaid / onOpenBrowser / onCancel: 交互回调
//   onFrameError: iframe 加载失败（回退浏览器打开，仅 iframe 兜底路径用到）
// }
export function PayQrModal({
  desc,
  amountYuan,
  payUrl,
  wapPayUrl,
  paid,
  checking,
  onConfirmPaid,
  onOpenBrowser,
  onCancel,
  onFrameError,
}) {
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");

  // wapPayUrl → 本地生成二维码（不依赖任何远程页面）
  useEffect(() => {
    let cancelled = false;
    setQrDataUrl("");
    if (!wapPayUrl) return undefined;
    QRCode.toDataURL(wapPayUrl, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        /* 生成失败时下方仍显示加载态，可走「在浏览器中打开」兜底 */
      });
    return () => {
      cancelled = true;
    };
  }, [wapPayUrl]);

  const useLocalQr = !!wapPayUrl;
  const qrReady = useLocalQr ? !!qrDataUrl : frameLoaded;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onClick={paid ? undefined : onCancel}
    >
      <div
        className="w-[320px] rounded-2xl bg-white dark:bg-neutral-900 border border-gray-100 dark:border-neutral-800 shadow-2xl p-6 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 + 购买内容 */}
        <div className="flex items-center justify-center gap-1.5">
          <QrCode className="w-4 h-4 text-blue-500" />
          <span className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
            支付宝扫码支付
          </span>
        </div>
        <p className="mt-1 text-[12px] text-gray-500 dark:text-neutral-400">{desc}</p>

        {/* 二维码居中：优先本地生成的 wap 收银台二维码；无 wapPayUrl 回退 iframe 嵌入页 */}
        <div className="mt-4 mx-auto w-[220px] h-[220px] relative rounded-xl border border-gray-100 dark:border-neutral-700 bg-white overflow-hidden">
          {!qrReady && !paid && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
            </div>
          )}
          {paid ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white dark:bg-neutral-900">
              <CheckCircle2 className="w-12 h-12 text-green-500" />
              <span className="text-[14px] font-medium text-green-600 dark:text-green-400">
                支付成功，已到账
              </span>
            </div>
          ) : useLocalQr ? (
            qrDataUrl && (
              <img
                src={qrDataUrl}
                alt="支付宝付款二维码"
                width="220"
                height="220"
                className="block"
              />
            )
          ) : (
            <iframe
              title="支付宝扫码"
              src={payUrl}
              width="220"
              height="220"
              scrolling="no"
              className="border-0 block"
              style={{ opacity: frameLoaded ? 1 : 0 }}
              onLoad={() => setFrameLoaded(true)}
              onError={onFrameError}
            />
          )}
        </div>

        {/* 金额大字 + 扫码提示 */}
        <div className="mt-3 flex items-baseline justify-center gap-0.5">
          <span className="text-[14px] text-gray-500 dark:text-neutral-400">¥</span>
          <span className="text-[26px] font-bold text-gray-900 dark:text-gray-100">
            {amountYuan}
          </span>
        </div>
        {!paid && (
          <p className="mt-0.5 text-[12px] text-gray-500 dark:text-neutral-400">
            请使用手机支付宝扫一扫完成付款
          </p>
        )}

        {/* 支付状态区：到账自动检测中 / 成功 */}
        {paid ? (
          <p className="mt-3 text-[12px] text-green-600 dark:text-green-400">
            窗口即将自动关闭…
          </p>
        ) : (
          <>
            <div className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-gray-400 dark:text-neutral-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              等待付款中，到账后自动提示
            </div>
            <button
              type="button"
              onClick={onConfirmPaid}
              disabled={checking}
              className="mt-3 w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {checking && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              我已完成支付 · 刷新额度
            </button>
            <div className="mt-2.5 flex items-center justify-center gap-4 text-[12px]">
              <button
                type="button"
                onClick={onOpenBrowser}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                无法扫码？在浏览器中打开
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="text-gray-500 dark:text-neutral-400 hover:underline"
              >
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

export default PayQrModal;
