import com.cisco.pt.ipc.IPCFactory;
import com.cisco.pt.ipc.sim.Device;
import com.cisco.pt.ipc.sim.Network;
import com.cisco.pt.ipc.ui.AppWindow;
import com.cisco.pt.ipc.ui.IPC;
import com.cisco.pt.ptmp.PacketTracerSession;
import com.cisco.pt.ptmp.impl.PacketTracerSessionFactoryImpl;

/** Read-only probe: connects to a running Packet Tracer over PTMP and prints basic state. */
public class Probe {
    public static void main(String[] args) throws Exception {
        String host = args.length > 0 ? args[0] : "localhost";
        int port = args.length > 1 ? Integer.parseInt(args[1]) : 39000;

        PacketTracerSession session = PacketTracerSessionFactoryImpl.getInstance().openSession(host, port);
        System.out.println("connected=" + session.isConnected() + " ipcReady=" + session.isIpcReady());
        IPC ipc = new IPCFactory(session).getIPC();

        AppWindow win = ipc.appWindow();
        System.out.println("version=" + win.getVersion());
        System.out.println("mode=" + (win.isSimulationMode() ? "simulation" : "realtime"));
        var file = win.getActiveFile();
        System.out.println("activeFile=" + (file == null ? null : file.getSavedFilename()));

        Network net = ipc.network();
        int n = net.getDeviceCount();
        System.out.println("devices=" + n + " links=" + net.getLinkCount());
        for (int i = 0; i < n; i++) {
            Device d = net.getDeviceAt(i);
            System.out.printf("  %-14s model=%-14s type=%s ports=%d power=%s%n",
                    d.getName(), d.getModel(), d.getType(), d.getPortCount(), d.getPower());
        }
        session.close();
        System.exit(0);
    }
}
