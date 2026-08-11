import { Link, useLocation } from 'react-router-dom';

const LINKS = [
  { to: '/', label: 'Table' },
  { to: '/map', label: 'Map' },
  { to: '/review', label: 'Review' },
  { to: '/drafts', label: 'Drafts' },
  { to: '/sequences', label: 'Sequences' },
  { to: '/manual', label: 'Manual' },
  { to: '/rejected', label: 'Rejected' },
] as const;

export const RouteNav = () => {
  const { pathname } = useLocation();
  return (
    <nav className="route-nav" aria-label="Primary">
      {LINKS.map((link) => {
        const active = link.to === '/'
          ? pathname === '/'
          : pathname === link.to || pathname.startsWith(`${link.to}/`);
        return (
          <Link
            key={link.to}
            to={link.to}
            className={active ? 'is-active' : undefined}
            aria-current={active ? 'page' : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
};
