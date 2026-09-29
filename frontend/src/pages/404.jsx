import Link from "next/link";
import { useTranslation } from "react-i18next";
import styles from "../styles/404.module.css";

export default function Custom404() {
  const { t } = useTranslation();
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.code} aria-label="404">404</div>
        <h1 className={styles.title}>{t("notFound.title")}</h1>
        <p className={styles.desc}>
          {t("notFound.desc")}
        </p>

        <div className={styles.actions}>
          <Link href="/" className="btn btn-primary">
            {t("notFound.backHome")}
          </Link>
          <Link href="/pay-fees" className="btn btn-ghost">
            {t("nav.payFees")}
          </Link>
        </div>

        <div className={styles.links}>
          <Link href="/dashboard" className={styles.link}>{t("nav.dashboard")}</Link>
          <Link href="/reports" className={styles.link}>{t("nav.reports")}</Link>
          <Link href="/login" className={styles.link}>{t("nav.adminLogin")}</Link>
        </div>
      </div>
    </div>
  );
}
