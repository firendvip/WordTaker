import React from "react";
import { Check } from "lucide-react";

// 设置页统一的行标签字号，权限行与快捷键行保持一致
const ROW_LABEL_CLASS = "text-[15px] font-medium text-gray-900 dark:text-gray-100";

const PermissionCard = ({
  icon: Icon,
  title,
  description,
  granted,
  onRequest,
  buttonText = "授予权限",
}) => {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon ? (
          <Icon className="w-[18px] h-[18px] text-gray-500 dark:text-gray-400 flex-shrink-0" />
        ) : null}
        <div className="min-w-0">
          <h3 className={`${ROW_LABEL_CLASS} chinese-title truncate`}>{title}</h3>
          {description ? (
            <p className="text-[13px] text-gray-500 dark:text-gray-400 truncate mt-0.5">{description}</p>
          ) : null}
        </div>
      </div>
      {granted ? (
        <div className="text-green-600 dark:text-green-400 flex items-center gap-1 flex-shrink-0">
          <Check className="w-4 h-4" />
          <span className="text-sm font-medium">已授予</span>
        </div>
      ) : (
        <button
          onClick={onRequest}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
        >
          {buttonText}
        </button>
      )}
    </div>
  );
};

export default PermissionCard;
