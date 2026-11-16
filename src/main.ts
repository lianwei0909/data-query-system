import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { initTheme } from './composables/useTheme'
import { loadShiftRows } from './core/shiftStore'
import './styles/tokens.css'
import './styles/app.css'

initTheme()
loadShiftRows()          // 启动时读一次班表（同时把旧版「X月X日」数据迁移成带年份）
createApp(App).use(router).mount('#app')
