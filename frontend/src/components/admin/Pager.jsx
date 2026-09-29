import { useTranslation } from "react-i18next";
import { IconChevronLeft, IconChevronRight } from "../Icons";

/**
 * Pager — shared previous/next pagination footer for admin list screens (#1581).
 */
export default function Pager({ page, pages, total, loading, onChange, label }) {
  const { t } = useTranslation();
  if (!total) return null;
  const lastPage = Math.max(1, pages || 1);

  return (
    <div className="admin-pager">
      <span className="pagination-info" aria-live="polite">
        {t("adminCommon.totalCount", { count: total })}
      </span>
      <nav className="pagination-controls" aria-label={label || t("adminCommon.paginationAria")}>
        <button
          type="button"
          className="page-btn"
          disabled={page <= 1 || loading}
          onClick={() => onChange(page - 1)}
          aria-label={t("actions.previousPage")}
        >
          <IconChevronLeft size={15} /> {t("actions.prev")}
        </button>
        <span className="text-muted" aria-current="page">{page} / {lastPage}</span>
        <button
          type="button"
          className="page-btn"
          disabled={page >= lastPage || loading}
          onClick={() => onChange(page + 1)}
          aria-label={t("actions.nextPage")}
        >
          {t("actions.next")} <IconChevronRight size={15} />
        </button>
      </nav>
    </div>
  );
}
