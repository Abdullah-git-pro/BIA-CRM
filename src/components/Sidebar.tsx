'use client';

import React from 'react';
import {
  Box, Drawer, List, ListItem, ListItemButton, ListItemIcon,
  ListItemText, Divider, Typography, Tooltip, IconButton,
} from '@mui/material';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStickyState } from '@/hooks/useStickyState';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PeopleIcon from '@mui/icons-material/People';
import QueueIcon from '@mui/icons-material/PlaylistAddCheck';
import CampaignIcon from '@mui/icons-material/Campaign';
import LogoutIcon from '@mui/icons-material/Logout';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import AssessmentIcon from '@mui/icons-material/Assessment';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import InsightsIcon from '@mui/icons-material/Insights';
import PhoneIcon from '@mui/icons-material/Phone';
import MarkEmailReadIcon from '@mui/icons-material/MarkEmailRead';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import PlaylistAddCheckIcon from '@mui/icons-material/PlaylistAddCheck';
import DataObjectIcon from '@mui/icons-material/DataObject';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useAuth } from '@/context/AuthContext';

export const SIDEBAR_EXPANDED  = 240;
export const SIDEBAR_COLLAPSED = 64;

// ── Palette (matches theme sidebar bg) ────────────────────────────────────────
const BG        = '#0f172a';  // slate-900
const ACTIVE_BG = 'rgba(37, 99, 235, 0.18)';
const HOVER_BG  = 'rgba(255, 255, 255, 0.06)';
const ACTIVE_BORDER = '#2563eb';
const ICON_DEFAULT  = 'rgba(255,255,255,0.55)';
const ICON_ACTIVE   = '#60a5fa';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Mobile (<md) temporary-drawer state. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export default function Sidebar({ collapsed, onToggle, mobileOpen = false, onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  /**
   * Whether the Campaigns group is open.
   *
   * Starts open and survives navigating away, so the two screens under it are not hidden
   * from anybody who has not found them yet — a closed-by-default group would make the send
   * check invisible to exactly the person who needs it.
   */
  /**
   * Open state is PER GROUP, keyed by the parent's path.
   *
   * It was a single flag, which was right while Campaigns was the only group. A second one
   * under Phone made the two share a chevron: collapsing Campaigns hid Call coverage, and
   * the arrow next to Phone reported the state of a group somewhere else on the list.
   */
  const [openGroups, setOpenGroups] = useStickyState<Record<string, boolean>>('nav:openGroups', {});
  const isGroupOpen = (path: string) => openGroups[path] ?? true;
  const toggleGroup = (path: string) =>
    setOpenGroups((prev) => ({ ...prev, [path]: !(prev[path] ?? true) }));
  const { logout, user } = useAuth();

  const isActive = (path: string) =>
    path === '/dashboard' ? pathname === '/dashboard' || pathname === '/'
    : pathname === path || pathname.startsWith(path + '/');

  const handleLogout = async () => {
    onMobileClose?.();
    // logout() clears client state and hard-redirects to /login itself.
    await logout();
  };

  const navItems = [
    { label: 'Dashboard',   icon: <DashboardIcon />,        path: '/dashboard' },
    { label: 'Leads',       icon: <PeopleIcon />,           path: '/leads' },
    { label: 'Lead Queues', icon: <QueueIcon />,            path: '/queue' },
    // Super-admin only: user / role management
    ...(user?.role === 'superadmin' ? [
      { label: 'Users',       icon: <ManageAccountsIcon />,  path: '/admin/users' },
    ] : []),
    // Admin + super-admin: data operations
    ...(user?.role === 'superadmin' || user?.role === 'admin' ? [
      /**
       * First in the admin group, because it is the only screen that answers 'what should
       * I do next' rather than 'what is true'. Everything below it is a report.
       */
      /**
       * First in the admin group, because it is the only screen that answers 'what should
       * I do next' rather than 'what is true'. Everything below it is a report.
       */
      { label: 'To do',       icon: <PlaylistAddCheckIcon />, path: '/admin/workflow' },
      // Above QC. QC is where somebody goes when they suspect a problem; the ledger is the
      // standing measure of the pipeline and the first thing Frank reads.
      { label: 'Cohorts',     icon: <SwapVertIcon />,        path: '/admin/cohorts' },
      { label: 'QC Reports',  icon: <AssessmentIcon />,      path: '/admin/qc' },
      { label: 'Outreach',    icon: <InsightsIcon />,        path: '/admin/outreach' },
      { label: 'Weekly Pull', icon: <EventRepeatIcon />,     path: '/admin/pull-weekly' },
      // Its own entry because Zoya opens it, and she does not otherwise come to QC Reports.
      // Burying a file upload inside a reporting screen is how it goes on being done by
      // whoever has a terminal.
      { label: 'Verification', icon: <MarkEmailReadIcon />,   path: '/admin/verification' },
      /**
       * Next to Verification because they are the two halves of "can we mail this address":
       * one asks whether the mailbox is alive, the other whether it belongs to the insured.
       * Ruben works this one, so it is a top-level entry rather than a tab he has to know
       * about — a queue nobody can find is a queue nobody clears.
       */
      { label: 'Name check',  icon: <PersonSearchIcon />,     path: '/admin/name-review' },

      /**
       * ── The two groups that expand, kept last (Abdullah, 9 Oct 2026) ─────────
       *
       * Campaigns and Phone are the only entries with children, and open they add six
       * rows between Users and Cohorts — so the reports underneath moved depending on
       * what somebody had expanded, and the list had no stable shape to learn.
       *
       * At the bottom they can grow without pushing anything, and the flat reports above
       * stay where they were last time. Order between them is unchanged.
       */
      { label: 'Campaigns',   icon: <CampaignIcon />,        path: '/lead-campaigns' },
      /**
       * Indented under Campaigns, because neither is a place anybody goes on its own — one
       * holds the values the copy uses and the other answers "why hasn't this gone out",
       * and both questions start from a campaign. Shown as siblings they read as two more
       * top-level areas of the CRM, which is three things to scan instead of one.
       *
       * Collapsible, at the cost noted below: a group that starts closed is a group whose
       * contents somebody has to already know about. It therefore starts OPEN and remembers
       * what you last chose, so closing it is a decision rather than a default that quietly
       * hides it from anybody who has not already found it.
       */
      { label: 'Email variables', icon: <DataObjectIcon />, path: '/admin/merge-variables', child: true, parent: '/lead-campaigns' },
      { label: 'Subject lines', icon: <DataObjectIcon />, path: '/admin/subjects', child: true, parent: '/lead-campaigns' },
      { label: 'CTAs', icon: <CampaignIcon />, path: '/admin/ctas', child: true, parent: '/lead-campaigns' },
      { label: 'Campaign copy', icon: <DataObjectIcon />, path: '/admin/campaign-copy', child: true, parent: '/lead-campaigns' },
      { label: 'Can we send?', icon: <FactCheckIcon />, path: '/admin/send-check', child: true, parent: '/lead-campaigns' },
      // Its own entry rather than a tab inside Outreach: this one is a work queue somebody
      // opens to find the next call, not a report they open to read numbers.
      { label: 'Phone',       icon: <PhoneIcon />,           path: '/admin/phone' },
      // Under Phone, because it answers the question the queue cannot: how much of the
      // cohort has actually been dialled. On 1 Oct C1 held 326 numbers with 15 worked and
      // nothing in the CRM said so — Frank asked twice and nobody could answer.
      { label: 'Call coverage', icon: <FactCheckIcon />, path: '/admin/call-coverage', child: true, parent: '/admin/phone' },
    ] : []),
  ];

  // Shared sidebar body. On mobile we always render the full (expanded) layout
  // and swap the collapse toggle for a close button; tapping a nav item closes it.
  const renderContent = (isCollapsed: boolean, mobile: boolean) => (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: BG,
        color: 'white',
        overflowX: 'hidden',
        transition: 'width 0.22s ease',
        width: isCollapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED,
      }}
    >
      {/* ── Logo / header ───────────────────────────────────────────────── */}
      <Box
        sx={{
          px: 1.5,
          py: 1.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: isCollapsed ? 'center' : 'space-between',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          minHeight: 56,
          gap: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, overflow: 'hidden', flex: isCollapsed ? 'none' : 1 }}>
          <Box
            sx={{
              width: 30, height: 30, borderRadius: 1, backgroundColor: '#2563eb',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <Typography sx={{ fontSize: '0.75rem', fontWeight: 900, color: '#fff', lineHeight: 1 }}>BIA</Typography>
          </Box>
          {!isCollapsed && (
            <Typography sx={{ fontWeight: 800, fontSize: '1rem', letterSpacing: '0.03em', color: '#f8fafc', whiteSpace: 'nowrap' }}>
              CRM
            </Typography>
          )}
        </Box>

        {mobile ? (
          <IconButton onClick={onMobileClose} size="small" aria-label="Close menu"
            sx={{ color: 'rgba(255,255,255,0.5)', flexShrink: 0, '&:hover': { color: '#fff', backgroundColor: HOVER_BG } }}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        ) : !isCollapsed && (
          <Tooltip title="Collapse sidebar" placement="right">
            <IconButton onClick={onToggle} size="small"
              sx={{ color: 'rgba(255,255,255,0.4)', flexShrink: 0, '&:hover': { color: '#fff', backgroundColor: HOVER_BG } }}>
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Expand button pinned at top when collapsed (desktop only) */}
      {!mobile && isCollapsed && (
        <Tooltip title="Expand sidebar" placement="right">
          <IconButton onClick={onToggle} size="small"
            sx={{ mt: 0.5, mx: 'auto', display: 'flex', color: 'rgba(255,255,255,0.4)', '&:hover': { color: '#fff', backgroundColor: HOVER_BG } }}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}

      {/* ── Nav items ───────────────────────────────────────────────────── */}
      <List sx={{ flex: 1, pt: 1.5, px: isCollapsed ? 0.5 : 1 }}>
        {navItems.map((item) => {
          const active = isActive(item.path);
          /**
           * Sub-items sit under their parent.
           *
           * Never indented while collapsed: there is no parent label on screen to sit under,
           * so the indent would read as misaligned icons rather than as nesting.
           */
          const child = (item as { child?: boolean }).child === true && !isCollapsed;
          const btn = (
            <ListItemButton
              component={Link}
              href={item.path}
              selected={active}
              onClick={mobile ? onMobileClose : undefined}
              sx={{
                borderRadius: 1.5,
                mb: 0.5,
                px: isCollapsed ? 1.25 : 1.5,
                pl: child ? 3.25 : undefined,
                py: child ? 0.75 : 1,
                justifyContent: isCollapsed ? 'center' : 'flex-start',
                backgroundColor: active ? ACTIVE_BG : 'transparent',
                borderLeft: active ? `3px solid ${ACTIVE_BORDER}` : '3px solid transparent',
                '&:hover': { backgroundColor: active ? ACTIVE_BG : HOVER_BG },
                transition: 'all 0.15s ease',
                minHeight: child ? 38 : 44,
              }}
            >
              <ListItemIcon sx={{ color: active ? ICON_ACTIVE : ICON_DEFAULT, minWidth: isCollapsed ? 0 : (child ? 30 : 36), justifyContent: 'center', '& svg': { fontSize: child ? 18 : undefined } }}>
                {item.icon}
              </ListItemIcon>
              {!isCollapsed && (
                <ListItemText
                  primary={item.label}
                  slotProps={{
                    primary: {
                      sx: {
                        fontSize: child ? '0.82rem' : '0.875rem',
                        fontWeight: active ? 700 : 400,
                        color: active ? '#f8fafc' : 'rgba(255,255,255,0.75)',
                      },
                    },
                  }}
                />
              )}
            </ListItemButton>
          );

          /**
           * A sub-item is hidden when its group is closed — and always shown while the
           * sidebar is collapsed, where the group heading is not on screen to be opened.
           */
          const parent = (item as { parent?: string }).parent;
          if (parent && !isCollapsed && !isGroupOpen(parent)) return null;

          /**
           * The chevron toggles; the row still navigates.
           *
           * Making the whole row toggle would cost the parent its own destination, and
           * Campaigns is a page somebody actually wants. Two targets in one row is a small
           * price for keeping both behaviours.
           */
          const isGroupParent = !isCollapsed
            && navItems.some((n) => (n as { parent?: string }).parent === item.path);

          return (
            <ListItem
              key={item.path}
              disablePadding
              secondaryAction={isGroupParent ? (
                <Box
                  component="button"
                  aria-label={isGroupOpen(item.path) ? 'Collapse' : 'Expand'}
                  onClick={(e: React.MouseEvent) => { e.preventDefault(); toggleGroup(item.path); }}
                  sx={{
                    border: 0, background: 'transparent', cursor: 'pointer', p: 0.25,
                    display: 'flex', alignItems: 'center', color: 'rgba(255,255,255,0.55)',
                    '&:hover': { color: '#fff' },
                  }}
                >
                  {isGroupOpen(item.path) ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                </Box>
              ) : undefined}
            >
              {isCollapsed
                ? <Tooltip title={item.label} placement="right">{btn}</Tooltip>
                : btn}
            </ListItem>
          );
        })}
      </List>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.07)', mx: isCollapsed ? 0.5 : 1 }} />

      {/* ── User + logout ────────────────────────────────────────────────── */}
      <Box sx={{ px: isCollapsed ? 0.5 : 1, py: 1.5 }}>
        {!isCollapsed && user?.email && (
          <Typography
            variant="caption"
            sx={{ display: 'block', px: 1.5, pb: 1, color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {user.email}
          </Typography>
        )}
        {(() => {
          const logoutBtn = (
            <ListItemButton
              onClick={handleLogout}
              sx={{
                borderRadius: 1.5,
                px: isCollapsed ? 1.25 : 1.5,
                py: 1,
                justifyContent: isCollapsed ? 'center' : 'flex-start',
                backgroundColor: 'rgba(220,38,38,0.08)',
                '&:hover': { backgroundColor: 'rgba(220,38,38,0.18)' },
                minHeight: 44,
              }}
            >
              <ListItemIcon sx={{ color: '#f87171', minWidth: isCollapsed ? 0 : 36, justifyContent: 'center' }}>
                <LogoutIcon fontSize="small" />
              </ListItemIcon>
              {!isCollapsed && (
                <ListItemText primary="Logout" slotProps={{ primary: { sx: { fontSize: '0.875rem', fontWeight: 600, color: '#f87171' } } }} />
              )}
            </ListItemButton>
          );
          return isCollapsed
            ? <Tooltip title="Logout" placement="right">{logoutBtn}</Tooltip>
            : logoutBtn;
        })()}
      </Box>
    </Box>
  );

  const w = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;

  return (
    <>
      {/* Desktop (md+): permanent rail in the layout flow */}
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: 'none', md: 'block' },
          width: w,
          flexShrink: 0,
          transition: 'width 0.22s ease',
          '& .MuiDrawer-paper': {
            width: w,
            boxSizing: 'border-box',
            overflowX: 'hidden',
            border: 'none',
            transition: 'width 0.22s ease',
            boxShadow: '2px 0 8px rgba(0,0,0,0.25)',
          },
        }}
      >
        {renderContent(collapsed, false)}
      </Drawer>

      {/* Mobile (<md): temporary overlay drawer, opened from the top bar */}
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={onMobileClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: 'block', md: 'none' },
          '& .MuiDrawer-paper': {
            width: SIDEBAR_EXPANDED,
            boxSizing: 'border-box',
            overflowX: 'hidden',
            border: 'none',
          },
        }}
      >
        {renderContent(false, true)}
      </Drawer>
    </>
  );
}
