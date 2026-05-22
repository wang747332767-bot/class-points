const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// 中间件
app.use(cors());
app.use(express.json());

// 托管前端静态文件（我们稍后把 index.html 放在 public 目录下）
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 数据库连接 ----------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ 数据库连接成功'))
  .catch(err => console.error('❌ 数据库连接失败:', err));

// ---------- 数据模型 ----------
const studentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  group: { type: String, required: true },
  points: { type: Number, default: 0 },
  isLeader: { type: Boolean, default: false }
});
const Student = mongoose.model('Student', studentSchema);

const taskSchema = new mongoose.Schema({
  icon: { type: String, default: '⭐' },
  name: { type: String, required: true },
  points: { type: Number, required: true }  // 可为负数
});
const Task = mongoose.model('Task', taskSchema);

const logSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  studentName: String,
  change: Number,
  reason: String,
  newPoints: Number,
  createdAt: { type: Date, default: Date.now }
});
const Log = mongoose.model('Log', logSchema);

// ---------- 初始化默认任务（如果数据库为空）----------
async function initDefaultTasks() {
  const count = await Task.countDocuments();
  if (count === 0) {
    await Task.insertMany([
      { icon: '📖', name: '交作业', points: 2 },
      { icon: '✍️', name: '课堂发言', points: 3 },
      { icon: '🧹', name: '做值日', points: 2 },
      { icon: '🤝', name: '帮助同学', points: 5 },
      { icon: '🗣️', name: '上课讲话', points: -2 },
      { icon: '📵', name: '玩手机', points: -5 }
    ]);
    console.log('✅ 已初始化默认任务');
  }
}
// 数据库连上后初始化
mongoose.connection.once('open', () => {
  initDefaultTasks();
});

// ---------- API 路由 ----------

// 获取所有学生
app.get('/api/students', async (req, res) => {
  const students = await Student.find();
  res.json(students);
});

// 获取单个学生
app.get('/api/students/:id', async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: '学生不存在' });
    res.json(student);
  } catch (err) {
    res.status(500).json({ message: 'ID 格式错误' });
  }
});

// 添加学生
app.post('/api/students', async (req, res) => {
  try {
    const student = new Student(req.body);
    await student.save();
    io.emit('dataChanged');
    res.status(201).json(student);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 更新学生（姓名、小组、积分、组长）
app.put('/api/students/:id', async (req, res) => {
  try {
    const student = await Student.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!student) return res.status(404).json({ message: '学生不存在' });
    io.emit('dataChanged');
    res.json(student);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 删除学生
app.delete('/api/students/:id', async (req, res) => {
  try {
    const student = await Student.findByIdAndDelete(req.params.id);
    if (!student) return res.status(404).json({ message: '学生不存在' });
    io.emit('dataChanged');
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 积分变动（核心）
app.post('/api/students/:id/changePoints', async (req, res) => {
  try {
    const { change, reason } = req.body;  // change 可为正负数
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: '学生不存在' });

    const newPoints = student.points + change;
    // 不再限制不能为负，由前端决定
    student.points = newPoints;
    await student.save();

    // 记录日志
    const log = new Log({
      studentId: student._id,
      studentName: student.name,
      change,
      reason: reason || '手动变更',
      newPoints
    });
    await log.save();

    // 实时广播积分变动
    io.emit('pointUpdate', {
      userId: student._id.toString(),
      name: student.name,
      change,
      reason: reason || '手动变更',
      newPoints
    });

    res.json(student);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 获取任务列表
app.get('/api/tasks', async (req, res) => {
  const tasks = await Task.find();
  res.json(tasks);
});

// 批量更新任务（前端发送整个任务数组）
app.post('/api/tasks/batch', async (req, res) => {
  try {
    const tasksData = req.body;
    if (!Array.isArray(tasksData)) return res.status(400).json({ message: '请求体必须是数组' });
    await Task.deleteMany({});
    const tasks = await Task.insertMany(tasksData);
    io.emit('dataChanged');
    res.status(201).json(tasks);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 获取操作日志（最近50条）
app.get('/api/logs', async (req, res) => {
  const logs = await Log.find().sort({ createdAt: -1 }).limit(50);
  res.json(logs);
});

// ---------- WebSocket ----------
io.on('connection', (socket) => {
  console.log('🔗 客户端已连接');
  socket.on('disconnect', () => {
    console.log('❌ 客户端断开');
  });
});

// ---------- 启动服务器 ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { // 确保监听地址为 '0.0.0.0'
    console.log(`🚀 服务器已启动，监听端口：${PORT}`);
});