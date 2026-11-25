import { useNavigate, useLocation } from 'react-router-dom'
import { getActiveTabFromPath, useFilteredTabs } from './appBottomNavState'

export default function AppBottomNav({ tabs: tabsProp, activeTab: activeTabProp, onTabChange }) {
  const navigate = useNavigate()
  const location = useLocation()
  const defaultTabs = useFilteredTabs()
  const tabs = tabsProp || defaultTabs
  const activeTab = activeTabProp || getActiveTabFromPath(location.pathname)

  const handleTabClick = (tab) => {
    if (onTabChange) onTabChange(tab.id)
    navigate(tab.path)
  }

  return (
    <div
      data-chat-bottom-nav
      className="fixed inset-x-0 bottom-0 z-40 md:hidden border-t border-border bg-card shadow-[0_-4px_12px_rgba(0,0,0,0.05)]"
    >
      <div className="flex justify-around">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab)}
              className={`flex flex-col items-center py-3 px-2 flex-1 ${
                isActive ? 'text-primary' : 'text-muted-foreground'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="w-6 h-6" />
              <span className="text-xs mt-1">{tab.label}</span>
            </button>
          )
        })}
      </div>
      <div className="h-[max(env(safe-area-inset-bottom),0.75rem)] bg-card" />
    </div>
  )
}
